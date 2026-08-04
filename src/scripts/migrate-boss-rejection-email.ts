import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossForwardingDeliveryState,
  BossForwardingOutboxEntry,
  BossForwardingStatus,
} from '../types/job.js';

export interface BossRejectionEmailMigrationOptions {
  jobKey: string;
  /** Safe default: audit only. */
  dryRun?: boolean;
}

export interface BossRejectionEmailMigrationSummary {
  jobKey: string;
  dryRun: boolean;
  settings: {
    legacySecondaryForwarding: boolean;
    secondaryDeliveryPresent: boolean;
    enabled: boolean;
    removed: boolean;
    blocked: boolean;
  };
  snapshots: {
    oldSettingsSnapshots: number;
    oldTaskSnapshots: number;
    oldActiveSnapshots: number;
    oldScheduleSnapshots: number;
    activeTaskFiles: number;
    batchSnapshotFiles: number;
    scheduleTemplateFiles: number;
    legacyActiveTaskInputs: number;
    legacyScheduleInputs: number;
    requiresRequeue: boolean;
  };
  forwardingOutbox: {
    scanned: number;
    rejectedEntries: number;
    supersededEntries: number;
    convertedSendingToUncertain: number;
    preservedSentEntries: number;
    preservedUncertainEntries: number;
  };
  historicalEmailBackfill: 0;
  blockingIssues: string[];
  receiptWritten: boolean;
}

interface RawJobRecord {
  jobKey?: string;
  searchKeyword?: string;
  revision?: number;
  bossScreening?: {
    enabled?: boolean;
    secondaryDelivery?: unknown;
    secondaryForwarding?: unknown;
  };
}

async function readRawJobRecord(jobKey: string): Promise<RawJobRecord> {
  const filePath = path.join(config.dataDir, 'boss', 'jobs', jobKey, 'jd.json');
  return JSON.parse(await readFile(filePath, 'utf8')) as RawJobRecord;
}

function isUnfinishedStatus(status: BossForwardingStatus): boolean {
  return status === 'pending' || status === 'sending' || status === 'retryable-failed';
}

function isRejectedPostScoreEntry(entry: BossForwardingOutboxEntry): boolean {
  return entry.workflow !== 'pre-capture' && entry.classification === 'rejected';
}

function aggregateStatus(deliveries: readonly BossForwardingDeliveryState[]): BossForwardingStatus {
  if (deliveries.some((delivery) => delivery.status === 'uncertain')) return 'uncertain';
  if (deliveries.some((delivery) => delivery.status === 'superseded')) return 'superseded';
  if (deliveries.some((delivery) => delivery.status === 'sending')) return 'sending';
  if (deliveries.some((delivery) => delivery.status === 'retryable-failed')) return 'retryable-failed';
  if (deliveries.some((delivery) => delivery.status === 'pending')) return 'pending';
  return 'sent';
}

function expandDeliveries(entry: BossForwardingOutboxEntry): BossForwardingDeliveryState[] {
  if (entry.forwarding.deliveries && entry.forwarding.deliveries.length > 0) {
    return entry.forwarding.deliveries.map((delivery) => ({ ...delivery }));
  }
  const recipients = [
    { role: 'recipient' as const, recipient: entry.forwarding.recipient },
    ...(entry.forwarding.ccEmails ?? []).map((recipient) => ({ role: 'cc' as const, recipient })),
  ];
  const status = entry.forwarding.status === 'sent'
    ? 'sent'
    : entry.forwarding.status === 'uncertain' || entry.forwarding.status === 'sending'
      ? 'uncertain'
      : entry.forwarding.status === 'superseded'
        ? 'superseded'
        : entry.forwarding.status;
  return recipients.map(({ role, recipient }) => ({
    role,
    recipient,
    status,
    ...(entry.forwarding.attemptedAt ? { attemptedAt: entry.forwarding.attemptedAt } : {}),
    ...(status === 'sent' && entry.forwarding.completedAt ? { completedAt: entry.forwarding.completedAt } : {}),
  }));
}

function migrateRejectedForwardingEntry(
  entry: BossForwardingOutboxEntry,
  migratedAt: string,
): { entry: BossForwardingOutboxEntry; superseded: boolean; convertedSending: boolean; preservedSent: boolean; preservedUncertain: boolean } {
  const legacySending = !entry.forwarding.deliveries?.length && entry.forwarding.status === 'sending';
  const deliveries = expandDeliveries(entry);
  let superseded = false;
  let convertedSending = legacySending;
  let preservedSent = false;
  let preservedUncertain = false;
  const migratedDeliveries = deliveries.map((delivery) => {
    if (delivery.status === 'sent') {
      preservedSent = true;
      return delivery;
    }
    if (delivery.status === 'uncertain') {
      preservedUncertain = true;
      return delivery;
    }
    if (delivery.status === 'sending') {
      convertedSending = true;
      preservedUncertain = true;
      return {
        ...delivery,
        status: 'uncertain' as const,
        error: delivery.error ?? 'Converted from an in-flight rejected Boss forwarding during rejection-email migration; verify manually.',
      };
    }
    if (delivery.status === 'pending' || delivery.status === 'retryable-failed') {
      superseded = true;
      return {
        ...delivery,
        status: 'superseded' as const,
        error: delivery.error ?? 'Superseded because rejected candidates now use candidate-level email delivery.',
      };
    }
    return delivery;
  });
  const status = aggregateStatus(migratedDeliveries);
  return {
    entry: {
      ...entry,
      updatedAt: migratedAt,
      forwarding: {
        ...entry.forwarding,
        status,
        deliveries: migratedDeliveries,
        ...(status === 'sent' ? { error: undefined } : {
          error: `Rejected Boss forwarding migrated to candidate-level email delivery (${status}).`,
        }),
      },
    },
    superseded,
    convertedSending,
    preservedSent,
    preservedUncertain,
  };
}

async function listJsonFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child);
    }
  }
  await visit(root);
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotBelongsToJob(value: unknown, jobKey: string, jobName?: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.sourceJobKey === jobKey
    || (item.jobIdentity !== null && typeof item.jobIdentity === 'object'
      && ((item.jobIdentity as Record<string, unknown>).expectedJobName === jobKey
        || Boolean(jobName && (item.jobIdentity as Record<string, unknown>).expectedJobName === jobName)));
}

const legacySecondaryForwardFields = [
  'bossSecondaryForwardMode',
  'bossSecondaryForwardRecipient',
  'bossSecondaryForwardCc',
] as const;

function countOldSnapshotNodes(value: unknown, jobKey: string, jobName?: string): {
  oldSettingsSnapshots: number;
  oldTaskSnapshots: number;
} {
  const counts = { oldSettingsSnapshots: 0, oldTaskSnapshots: 0 };
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) return;
    if (current.version === 2 && current.primaryDelivery && snapshotBelongsToJob(current, jobKey, jobName)) {
      counts.oldSettingsSnapshots += 1;
    }
    if (current.version === 3 && current.deliveryAndScreening && snapshotBelongsToJob(current, jobKey, jobName)) {
      counts.oldTaskSnapshots += 1;
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return counts;
}

function inputMatchesJob(
  input: Record<string, unknown>,
  jobKey: string,
  jobName: string | undefined,
  snapshotCounts: { oldSettingsSnapshots: number; oldTaskSnapshots: number },
): boolean {
  if (snapshotCounts.oldSettingsSnapshots > 0 || snapshotCounts.oldTaskSnapshots > 0) return true;
  if (typeof input.keyword === 'string' && jobName && input.keyword.trim() === jobName.trim()) return true;
  return typeof input.bossJobId === 'string' && jobKey.includes(input.bossJobId.trim());
}

function hasLegacySecondaryForwardInput(input: Record<string, unknown>): boolean {
  return legacySecondaryForwardFields.some((field) => field in input);
}

async function readJsonIfPossible(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function countOldSnapshots(jobKey: string, jobName?: string): Promise<{
  oldSettingsSnapshots: number;
  oldTaskSnapshots: number;
  oldActiveSnapshots: number;
  oldScheduleSnapshots: number;
  activeTaskFiles: number;
  batchSnapshotFiles: number;
  scheduleTemplateFiles: number;
  legacyActiveTaskInputs: number;
  legacyScheduleInputs: number;
}> {
  const summary = {
    oldSettingsSnapshots: 0,
    oldTaskSnapshots: 0,
    oldActiveSnapshots: 0,
    oldScheduleSnapshots: 0,
    activeTaskFiles: 0,
    batchSnapshotFiles: 0,
    scheduleTemplateFiles: 0,
    legacyActiveTaskInputs: 0,
    legacyScheduleInputs: 0,
  };
  type SnapshotCounts = { oldSettingsSnapshots: number; oldTaskSnapshots: number };
  type BatchSnapshotScan = {
    counts: SnapshotCounts;
    matched: boolean;
    legacyMatch: boolean;
  };
  const emptyCounts = (): SnapshotCounts => ({ oldSettingsSnapshots: 0, oldTaskSnapshots: 0 });
  const snapshotCount = (counts: SnapshotCounts): number => counts.oldSettingsSnapshots + counts.oldTaskSnapshots;
  const batchScanCache = new Map<string, Promise<BatchSnapshotScan>>();
  const countedBatchFiles = new Set<string>();
  const taskSnapshotRoot = path.resolve(config.dataDir, 'server', 'task-snapshots');
  const mergeSnapshotCounts = (counts: { oldSettingsSnapshots: number; oldTaskSnapshots: number }): void => {
    summary.oldSettingsSnapshots += counts.oldSettingsSnapshots;
    summary.oldTaskSnapshots += counts.oldTaskSnapshots;
  };
  const resolveContainedTaskSnapshot = async (value: string): Promise<string | undefined> => {
    try {
      const [resolvedRoot, resolvedFile] = await Promise.all([
        realpath(taskSnapshotRoot),
        realpath(path.resolve(value)),
      ]);
      const relative = path.relative(resolvedRoot, resolvedFile);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? resolvedFile
        : undefined;
    } catch {
      return undefined;
    }
  };
  const scanBatchSnapshot = async (jobsFileValue: string): Promise<BatchSnapshotScan | undefined> => {
    const jobsFile = await resolveContainedTaskSnapshot(jobsFileValue);
    if (!jobsFile) return undefined;
    let pending = batchScanCache.get(jobsFile);
    if (!pending) {
      pending = (async () => {
        const counts = emptyCounts();
        const payload = await readJsonIfPossible(jobsFile);
        if (!Array.isArray(payload)) return { counts, matched: false, legacyMatch: false };
        let matched = false;
        let legacyMatch = false;
        for (const value of payload) {
          if (!isRecord(value)) continue;
          const itemCounts = countOldSnapshotNodes(value, jobKey, jobName);
          counts.oldSettingsSnapshots += itemCounts.oldSettingsSnapshots;
          counts.oldTaskSnapshots += itemCounts.oldTaskSnapshots;
          if (inputMatchesJob(value, jobKey, jobName, itemCounts)) {
            matched = true;
            if (hasLegacySecondaryForwardInput(value)) legacyMatch = true;
          }
        }
        return { counts, matched, legacyMatch };
      })();
      batchScanCache.set(jobsFile, pending);
    }
    const result = await pending;
    if (!countedBatchFiles.has(jobsFile)) {
      countedBatchFiles.add(jobsFile);
      mergeSnapshotCounts(result.counts);
      if (result.matched && (snapshotCount(result.counts) > 0 || result.legacyMatch)) {
        summary.batchSnapshotFiles += 1;
      }
    }
    return result;
  };
  const scanInput = async (
    input: Record<string, unknown>,
    source: 'active-task' | 'schedule',
  ): Promise<boolean> => {
    const directCounts = countOldSnapshotNodes(input, jobKey, jobName);
    mergeSnapshotCounts(directCounts);
    let relevant = snapshotCount(directCounts) > 0;
    if (source === 'active-task') summary.oldActiveSnapshots += snapshotCount(directCounts);
    else summary.oldScheduleSnapshots += snapshotCount(directCounts);
    const directLegacyMatch = inputMatchesJob(input, jobKey, jobName, directCounts)
      && hasLegacySecondaryForwardInput(input);
    if (directLegacyMatch) {
      if (source === 'active-task') summary.legacyActiveTaskInputs += 1;
      else summary.legacyScheduleInputs += 1;
      relevant = true;
    }
    if (typeof input.jobsFile !== 'string' || !input.jobsFile.trim()) return relevant;
    const batch = await scanBatchSnapshot(input.jobsFile);
    if (!batch) return relevant;
    if (source === 'active-task') summary.oldActiveSnapshots += snapshotCount(batch.counts);
    else summary.oldScheduleSnapshots += snapshotCount(batch.counts);
    if (batch.legacyMatch) {
      if (source === 'active-task') summary.legacyActiveTaskInputs += 1;
      else summary.legacyScheduleInputs += 1;
    }
    return relevant || snapshotCount(batch.counts) > 0 || batch.legacyMatch;
  };

  const taskFiles = await listJsonFilesRecursively(path.join(config.dataDir, 'runtime', 'tasks'));
  for (const file of taskFiles) {
    const value = await readJsonIfPossible(file);
    if (!isRecord(value) || (value.status !== 'queued' && value.status !== 'running') || !isRecord(value.input)) continue;
    if (await scanInput(value.input, 'active-task')) summary.activeTaskFiles += 1;
  }

  const scheduleFiles = await listJsonFilesRecursively(path.join(config.dataDir, 'runtime', 'schedules'));
  for (const file of scheduleFiles) {
    const value = await readJsonIfPossible(file);
    if (!isRecord(value) || !Array.isArray(value.tasks)) continue;
    let relevant = false;
    for (const task of value.tasks) {
      if (!isRecord(task) || !isRecord(task.input)) continue;
      relevant = await scanInput(task.input, 'schedule') || relevant;
    }
    if (relevant) summary.scheduleTemplateFiles += 1;
  }
  return summary;
}

export async function migrateBossRejectionEmailContract(
  options: BossRejectionEmailMigrationOptions,
): Promise<BossRejectionEmailMigrationSummary> {
  const dryRun = options.dryRun !== false;
  const rawJob = await readRawJobRecord(options.jobKey);
  const rawScreening = rawJob.bossScreening;
  const legacySecondaryForwarding = Boolean(rawScreening && rawScreening.secondaryForwarding !== undefined);
  const secondaryDeliveryPresent = Boolean(rawScreening?.secondaryDelivery);
  const enabled = rawScreening?.enabled === true;
  const blockingIssues: string[] = [];
  if (enabled && legacySecondaryForwarding && !secondaryDeliveryPresent) {
    blockingIssues.push('Enabled Boss screening has no secondaryDelivery recipient; address must be supplied manually before migration.');
  }
  const snapshots = await countOldSnapshots(options.jobKey, rawJob.searchKeyword);
  if (snapshots.oldActiveSnapshots > 0) {
    blockingIssues.push('Active Boss tasks contain old settings/task snapshots and require cancellation/requeue under the new contract.');
  }
  if (snapshots.oldScheduleSnapshots > 0) {
    blockingIssues.push('Boss schedule templates contain old settings/task snapshots and must be updated before migration.');
  }
  if (snapshots.legacyActiveTaskInputs > 0) {
    blockingIssues.push('Active Boss tasks still contain deprecated secondary-forwarding fields and require cancellation/requeue.');
  }
  if (snapshots.legacyScheduleInputs > 0) {
    blockingIssues.push('Boss schedule templates still contain deprecated secondary-forwarding fields and must be updated before migration.');
  }
  const requiresRequeue = snapshots.oldSettingsSnapshots > 0
    || snapshots.oldTaskSnapshots > 0
    || snapshots.legacyActiveTaskInputs > 0
    || snapshots.legacyScheduleInputs > 0;

  const store = new JobStore();
  const forwardingEntries = await store.listBossForwardingOutboxEntries('boss', options.jobKey);
  const rejectedEntries = forwardingEntries.filter(isRejectedPostScoreEntry);
  const unfinishedRejectedEntries = rejectedEntries.filter((entry) => {
    const statuses = entry.forwarding.deliveries?.map((delivery) => delivery.status)
      ?? [entry.forwarding.status];
    return statuses.some(isUnfinishedStatus);
  });
  const migratedAt = new Date().toISOString();
  const summary: BossRejectionEmailMigrationSummary = {
    jobKey: options.jobKey,
    dryRun,
    settings: {
      legacySecondaryForwarding,
      secondaryDeliveryPresent,
      enabled,
      removed: false,
      blocked: blockingIssues.some((issue) => issue.includes('secondaryDelivery recipient')),
    },
    snapshots: {
      ...snapshots,
      requiresRequeue,
    },
    forwardingOutbox: {
      scanned: forwardingEntries.length,
      rejectedEntries: rejectedEntries.length,
      supersededEntries: 0,
      convertedSendingToUncertain: 0,
      preservedSentEntries: 0,
      preservedUncertainEntries: 0,
    },
    historicalEmailBackfill: 0,
    blockingIssues,
    receiptWritten: false,
  };

  if (!dryRun && blockingIssues.length === 0) {
    if (legacySecondaryForwarding) {
      const job = await store.readJobRecord('boss', options.jobKey, { allowLegacyBossScreening: true });
      const migrationDir = path.join(config.dataDir, 'boss', 'jobs', options.jobKey, 'routing', 'migrations');
      await mkdir(migrationDir, { recursive: true });
      await copyFile(
        path.join(config.dataDir, 'boss', 'jobs', options.jobKey, 'jd.json'),
        path.join(migrationDir, `${migratedAt.replace(/[:.]/g, '-')}-before-rejection-email.json`),
      );
      await store.applyJobConfigPatch(
        'boss',
        options.jobKey,
        job.revision ?? 1,
        { bossScreening: job.bossScreening ?? null },
        { allowLegacyBossScreening: true },
      );
      summary.settings.removed = true;
    }
    for (const entry of unfinishedRejectedEntries) {
      const migrated = migrateRejectedForwardingEntry(entry, migratedAt);
      await store.saveBossForwardingOutboxEntry('boss', options.jobKey, migrated.entry);
      if (migrated.superseded) summary.forwardingOutbox.supersededEntries += 1;
      if (migrated.convertedSending) summary.forwardingOutbox.convertedSendingToUncertain += 1;
      if (migrated.preservedSent) summary.forwardingOutbox.preservedSentEntries += 1;
      if (migrated.preservedUncertain) summary.forwardingOutbox.preservedUncertainEntries += 1;
    }
    const migrationDir = path.join(config.dataDir, 'boss', 'jobs', options.jobKey, 'routing', 'migrations');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(path.join(migrationDir, `${migratedAt.replace(/[:.]/g, '-')}-rejection-email.json`), `${JSON.stringify({
      kind: 'boss-rejection-email-contract-migration',
      version: 1,
      jobKey: options.jobKey,
      migratedAt,
      settingsRemoved: summary.settings.removed,
      ...summary.forwardingOutbox,
      historicalEmailBackfill: 0,
    }, null, 2)}\n`, 'utf8');
    summary.receiptWritten = true;
  } else {
    summary.forwardingOutbox.supersededEntries = unfinishedRejectedEntries.filter((entry) => {
      const statuses = entry.forwarding.deliveries?.map((delivery) => delivery.status)
        ?? [entry.forwarding.status];
      return statuses.some((status) => status === 'pending' || status === 'retryable-failed');
    }).length;
    summary.forwardingOutbox.convertedSendingToUncertain = unfinishedRejectedEntries.filter((entry) => {
      const statuses = entry.forwarding.deliveries?.map((delivery) => delivery.status)
        ?? [entry.forwarding.status];
      return statuses.includes('sending');
    }).length;
  }
  return summary;
}

function parseArgs(argv: readonly string[]): BossRejectionEmailMigrationOptions {
  const jobKeyIndex = argv.indexOf('--job-key');
  const jobKey = jobKeyIndex >= 0 ? argv[jobKeyIndex + 1]?.trim() : undefined;
  if (!jobKey) throw new Error('Usage: npm run migrate:boss-rejection-email -- --job-key <job-key> [--dry-run true|false]');
  const dryRunIndex = argv.indexOf('--dry-run');
  const dryRunValue = dryRunIndex >= 0 ? argv[dryRunIndex + 1] : undefined;
  if (dryRunValue !== undefined && dryRunValue !== 'true' && dryRunValue !== 'false') {
    throw new Error('--dry-run must be true or false');
  }
  return { jobKey, dryRun: dryRunValue !== 'false' };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  migrateBossRejectionEmailContract(parseArgs(process.argv.slice(2)))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

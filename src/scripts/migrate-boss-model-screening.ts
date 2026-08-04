import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { hashBossScreeningPolicy } from '../scoring/boss-screening.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossForwardingDeliveryState,
  BossForwardingOutboxEntry,
  BossForwardingStatus,
  BossRejectionEmailOutboxEntry,
} from '../types/job.js';

export interface BossModelScreeningPolicyMigrationOptions {
  jobKey: string;
  dryRun: boolean;
}

export interface BossModelScreeningPolicyMigrationSummary {
  jobKey: string;
  dryRun: boolean;
  newPolicyHash: string;
  oldPolicyHashes: string[];
  outboxEntries: number;
  supersededDeliveries: number;
  preservedSentDeliveries: number;
  preservedUncertainDeliveries: number;
  rejectionEmailEntries: number;
  supersededRejectionEmails: number;
  uncertainRejectionEmails: number;
  pendingScoreItems: number;
  preservedPendingScoreItems: number;
}

function parseArgs(argv: readonly string[]): BossModelScreeningPolicyMigrationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry-run') {
      values.set(arg, 'true');
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unknown argument ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  const jobKey = values.get('--job-key')?.trim();
  if (!jobKey) throw new Error('Missing required argument --job-key');
  return { jobKey, dryRun: values.get('--dry-run') === 'true' };
}

function migrateRejectionEmailEntry(
  entry: BossRejectionEmailOutboxEntry,
  newPolicyHash: string,
  migratedAt: string,
): BossRejectionEmailOutboxEntry | undefined {
  if (entry.policyHash === newPolicyHash
    || entry.status === 'sent'
    || entry.status === 'uncertain'
    || entry.status === 'superseded') {
    return undefined;
  }
  if (entry.status === 'sending') {
    return {
      ...entry,
      status: 'uncertain',
      updatedAt: migratedAt,
      error: entry.error
        ?? 'Converted from an in-flight rejection email during Boss screening policy migration; verify the mailbox manually.',
    };
  }
  return {
    ...entry,
    status: 'superseded',
    updatedAt: migratedAt,
    error: entry.error
      ?? 'Superseded because the Boss screening policy changed before this rejection email was delivered.',
  };
}

function hashCandidateIds(candidateIds: readonly string[]): string {
  return createHash('sha256')
    .update([...candidateIds].sort().join('\n'))
    .digest('hex');
}

function isTerminalOutboxEntry(entry: BossForwardingOutboxEntry): boolean {
  const deliveries = entry.forwarding.deliveries;
  if (deliveries && deliveries.length > 0) {
    return deliveries.every((delivery) =>
      delivery.status === 'sent'
      || delivery.status === 'uncertain'
      || delivery.status === 'superseded',
    );
  }
  return entry.forwarding.status === 'sent'
    || entry.forwarding.status === 'uncertain'
    || entry.forwarding.status === 'superseded';
}

function requiresOutboxMigration(entry: BossForwardingOutboxEntry, newPolicyHash: string): boolean {
  // Current-policy work is owned by the normal retry/scoring workflow. Only an
  // unfinished entry proven to predate the v2 policy may be superseded here.
  return entry.policyHash !== newPolicyHash && !isTerminalOutboxEntry(entry);
}

function migrateDeliveries(entry: BossForwardingOutboxEntry): BossForwardingDeliveryState[] {
  if (entry.forwarding.deliveries && entry.forwarding.deliveries.length > 0) {
    return entry.forwarding.deliveries.map((delivery) => ({ ...delivery }));
  }

  const recipients = [
    { role: 'recipient' as const, recipient: entry.forwarding.recipient },
    ...(entry.forwarding.ccEmails ?? []).map((recipient) => ({ role: 'cc' as const, recipient })),
  ];
  const seen = new Set<string>();
  const status: BossForwardingStatus = entry.forwarding.status === 'sent'
    ? 'sent'
    : entry.forwarding.status === 'uncertain'
      ? 'uncertain'
      : entry.forwarding.status === 'sending'
        ? 'uncertain'
      : 'superseded';
  return recipients.filter(({ recipient }) => {
    const key = entry.forwarding.mode === 'email' ? recipient.toLocaleLowerCase('en-US') : recipient;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ role, recipient }) => ({
    role,
    recipient,
    status,
    ...(entry.forwarding.attemptedAt ? { attemptedAt: entry.forwarding.attemptedAt } : {}),
    ...(status === 'sent' && entry.forwarding.completedAt ? { completedAt: entry.forwarding.completedAt } : {}),
    ...(status === 'superseded' ? { error: 'Superseded by the Boss model screening policy v2 migration.' } : {}),
  }));
}

function supersedeOutboxEntry(entry: BossForwardingOutboxEntry, migratedAt: string): {
  entry: BossForwardingOutboxEntry;
  supersededDeliveries: number;
  preservedSentDeliveries: number;
  preservedUncertainDeliveries: number;
} {
  const deliveries = migrateDeliveries(entry);
  let supersededDeliveries = 0;
  let preservedSentDeliveries = 0;
  let preservedUncertainDeliveries = 0;
  const migratedDeliveries = deliveries.map((delivery) => {
    if (delivery.status === 'sent') {
      preservedSentDeliveries += 1;
      return delivery;
    }
    if (delivery.status === 'uncertain') {
      preservedUncertainDeliveries += 1;
      return delivery;
    }
    supersededDeliveries += 1;
    return {
      ...delivery,
      status: 'superseded' as const,
      error: delivery.error ?? 'Superseded by the Boss model screening policy v2 migration.',
    };
  });
  const hasUncertain = migratedDeliveries.some((delivery) => delivery.status === 'uncertain');
  const hasSuperseded = migratedDeliveries.some((delivery) => delivery.status === 'superseded');
  const status: BossForwardingStatus = hasUncertain
    ? 'uncertain'
    : hasSuperseded
      ? 'superseded'
      : 'sent';
  const forwarding = {
    ...entry.forwarding,
    status,
    deliveries: migratedDeliveries,
    updatedAt: migratedAt,
    ...(status === 'sent' ? {} : { error: 'Superseded by the Boss model screening policy v2 migration.' }),
  };
  return {
    entry: { ...entry, updatedAt: migratedAt, forwarding },
    supersededDeliveries,
    preservedSentDeliveries,
    preservedUncertainDeliveries,
  };
}

export async function migrateBossModelScreeningPolicy(
  options: BossModelScreeningPolicyMigrationOptions,
): Promise<BossModelScreeningPolicyMigrationSummary> {
  const store = new JobStore();
  const job = await store.readJobRecord('boss', options.jobKey);
  if (!job.bossScreening || job.bossScreening.policyVersion !== 2) {
    throw new Error(`Boss job ${options.jobKey} is not using model screening policy v2`);
  }
  const newPolicyHash = hashBossScreeningPolicy(job.bossScreening);
  const [entries, rejectionEmailEntries, workItems] = await Promise.all([
    store.listBossForwardingOutboxEntries('boss', options.jobKey),
    store.listBossRejectionEmailOutboxEntries('boss', options.jobKey),
    store.listBossScreeningWorkItems('boss', options.jobKey),
  ]);
  const migratedAt = new Date().toISOString();
  const oldPolicyHashes = [...new Set([
    ...entries.map((entry) => entry.policyHash),
    ...rejectionEmailEntries.map((entry) => entry.policyHash),
  ].filter((hash) => hash !== newPolicyHash))];
  const pendingScoreItemsToMigrate = workItems.filter((item) => item.policyHash !== newPolicyHash);
  const summary = entries.reduce((total, entry) => {
    if (!requiresOutboxMigration(entry, newPolicyHash)) {
      return total;
    }
    const migrated = supersedeOutboxEntry(entry, migratedAt);
    return {
      outboxEntries: total.outboxEntries + 1,
      supersededDeliveries: total.supersededDeliveries + migrated.supersededDeliveries,
      preservedSentDeliveries: total.preservedSentDeliveries + migrated.preservedSentDeliveries,
      preservedUncertainDeliveries: total.preservedUncertainDeliveries + migrated.preservedUncertainDeliveries,
    };
  }, {
    outboxEntries: 0,
    supersededDeliveries: 0,
    preservedSentDeliveries: 0,
    preservedUncertainDeliveries: 0,
  });
  const migratedRejectionEmails = rejectionEmailEntries
    .map((entry) => migrateRejectionEmailEntry(entry, newPolicyHash, migratedAt))
    .filter((entry): entry is BossRejectionEmailOutboxEntry => entry !== undefined);
  const rejectionEmailSummary = {
    rejectionEmailEntries: migratedRejectionEmails.length,
    supersededRejectionEmails: migratedRejectionEmails.filter((entry) => entry.status === 'superseded').length,
    uncertainRejectionEmails: migratedRejectionEmails.filter((entry) => entry.status === 'uncertain').length,
  };

  if (!options.dryRun) {
    for (const entry of entries) {
      if (!requiresOutboxMigration(entry, newPolicyHash)) {
        continue;
      }
      await store.saveBossForwardingOutboxEntry(
        'boss',
        options.jobKey,
        supersedeOutboxEntry(entry, migratedAt).entry,
      );
    }
    for (const entry of migratedRejectionEmails) {
      await store.saveBossRejectionEmailOutboxEntry('boss', options.jobKey, entry);
    }
    for (const item of pendingScoreItemsToMigrate) {
      await store.deleteBossScreeningWorkItem('boss', options.jobKey, item.candidateId);
    }
    const migrationDir = path.join(config.dataDir, 'boss', 'jobs', options.jobKey, 'routing', 'migrations');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(path.join(migrationDir, `${migratedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify({
      kind: 'boss-model-screening-policy-migration',
      version: 1,
      jobKey: options.jobKey,
      migratedAt,
      newPolicyHash,
      oldPolicyHashes,
      ...summary,
      ...rejectionEmailSummary,
      pendingScoreItems: pendingScoreItemsToMigrate.length,
      pendingScoreCandidateIdsHash: hashCandidateIds(pendingScoreItemsToMigrate.map((item) => item.candidateId)),
    }, null, 2)}\n`, 'utf8');
  }

  return {
    jobKey: options.jobKey,
    dryRun: options.dryRun,
    newPolicyHash,
    oldPolicyHashes,
    ...summary,
    ...rejectionEmailSummary,
    pendingScoreItems: pendingScoreItemsToMigrate.length,
    preservedPendingScoreItems: workItems.length - pendingScoreItemsToMigrate.length,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  migrateBossModelScreeningPolicy(parseArgs(process.argv.slice(2)))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

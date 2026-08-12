import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type {
  PlatformSavedSearchOpenEvidence,
  SubscriptionManagementEvidence,
} from '../types/job.js';

export interface SubscriptionMutationIntent {
  version: 1;
  platform: SupportedPlatform;
  savedSearchName: string;
  expectedKeyword: string;
  conditionFingerprint: string;
}

export interface SubscriptionMutationAttempt {
  version: 1;
  attemptId: string;
  intentHash: string;
  intent: SubscriptionMutationIntent;
  status: 'prepared' | 'dispatching' | 'confirmed' | 'already-satisfied' | 'ambiguous';
  revision: number;
  createdAt: string;
  updatedAt: string;
  evidence?: SubscriptionManagementEvidence;
  issue?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function hashSubscriptionMutationValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizeText(value: string, label: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized) throw new Error(`${label} must be non-empty.`);
  return normalized;
}

export function buildSubscriptionManagementEvidence(input: {
  platform: SupportedPlatform;
  savedSearchName: string;
  expectedKeyword: string;
  conditionFingerprint: string;
  postcondition: SubscriptionManagementEvidence['postcondition'];
  verifiedAt?: string;
  savedSearch?: SubscriptionManagementEvidence['savedSearch'];
  openEvidence?: PlatformSavedSearchOpenEvidence;
}): SubscriptionManagementEvidence {
  const savedSearchName = normalizeText(input.savedSearchName, 'savedSearchName');
  const expectedKeyword = normalizeText(input.expectedKeyword, 'expectedKeyword');
  const base = {
    version: 1 as const,
    platform: input.platform,
    savedSearchName,
    expectedKeyword,
    conditionFingerprint: normalizeText(input.conditionFingerprint, 'conditionFingerprint'),
    postcondition: input.postcondition,
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    ...(input.savedSearch ? { savedSearch: input.savedSearch } : {}),
  };
  const openEvidence = input.openEvidence;
  if (openEvidence && (openEvidence.platform !== input.platform
    || openEvidence.observedKeyword !== expectedKeyword
    || openEvidence.postcondition !== 'opened-and-verified')) {
    throw new Error('Subscription management open evidence does not match the mutation result.');
  }
  if (openEvidence?.identityKind === 'zhilian-native-condition') {
    if (input.platform !== 'zhilian') {
      throw new Error('Native-condition subscription management evidence is Zhilian-only.');
    }
    const unsigned = {
      ...base,
      platform: 'zhilian' as const,
      identityKind: 'zhilian-native-condition' as const,
      uniqueness: 'unique-native-condition-match' as const,
      observedNativeConditionId: openEvidence.observedNativeConditionId,
      observedConditionFingerprint: openEvidence.observedConditionFingerprint,
      openEvidenceHash: openEvidence.evidenceHash,
    };
    return { ...unsigned, evidenceHash: hashSubscriptionMutationValue(unsigned) };
  }
  if (openEvidence && openEvidence.observedName !== savedSearchName) {
    throw new Error('Exact-name subscription management evidence does not match savedSearchName.');
  }
  const unsigned = {
    ...base,
    uniqueness: 'unique-exact-match' as const,
  };
  return { ...unsigned, evidenceHash: hashSubscriptionMutationValue(unsigned) };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class SubscriptionMutationAttemptStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: { dataDir?: string; now?: () => Date } = {}) {
    this.rootDir = path.join(path.resolve(options.dataDir ?? config.dataDir), 'maintenance', 'subscription-mutations');
    this.now = options.now ?? (() => new Date());
  }

  private pathFor(attemptId: string): string {
    if (!/^subscription-[a-f0-9]{64}$/u.test(attemptId)) throw new Error('Invalid subscription mutation attempt ID.');
    return path.join(this.rootDir, `${attemptId}.json`);
  }

  async read(attemptId: string): Promise<SubscriptionMutationAttempt> {
    const value = JSON.parse(await fs.readFile(this.pathFor(attemptId), 'utf8')) as SubscriptionMutationAttempt;
    if (value.version !== 1 || value.attemptId !== attemptId || value.intentHash !== hashSubscriptionMutationValue(value.intent)) {
      throw new Error('Subscription mutation attempt is malformed or tampered.');
    }
    return value;
  }

  private normalizeIntent(intentInput: Omit<SubscriptionMutationIntent, 'version'>): SubscriptionMutationIntent {
    return {
      version: 1,
      platform: intentInput.platform,
      savedSearchName: normalizeText(intentInput.savedSearchName, 'savedSearchName'),
      expectedKeyword: normalizeText(intentInput.expectedKeyword, 'expectedKeyword'),
      conditionFingerprint: normalizeText(intentInput.conditionFingerprint, 'conditionFingerprint'),
    };
  }

  async find(
    intentInput: Omit<SubscriptionMutationIntent, 'version'>,
  ): Promise<SubscriptionMutationAttempt | undefined> {
    const intent = this.normalizeIntent(intentInput);
    const attemptId = `subscription-${hashSubscriptionMutationValue(intent)}`;
    try {
      return await this.read(attemptId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async prepare(intentInput: Omit<SubscriptionMutationIntent, 'version'>): Promise<SubscriptionMutationAttempt> {
    const intent = this.normalizeIntent(intentInput);
    const intentHash = hashSubscriptionMutationValue(intent);
    const attemptId = `subscription-${intentHash}`;
    try {
      const existing = await this.read(attemptId);
      if (existing.status === 'dispatching' || existing.status === 'ambiguous') {
        throw new Error(`Subscription mutation ${attemptId} is ${existing.status}; reconcile it before another save attempt.`);
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const timestamp = this.now().toISOString();
    const attempt: SubscriptionMutationAttempt = {
      version: 1,
      attemptId,
      intentHash,
      intent,
      status: 'prepared',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeJsonAtomically(this.pathFor(attemptId), attempt);
    return attempt;
  }

  private async transition(
    attempt: SubscriptionMutationAttempt,
    status: SubscriptionMutationAttempt['status'],
    patch: Pick<SubscriptionMutationAttempt, 'evidence' | 'issue'> = {},
  ): Promise<SubscriptionMutationAttempt> {
    const current = await this.read(attempt.attemptId);
    if (current.revision !== attempt.revision || current.status !== attempt.status) {
      throw new Error(`Subscription mutation ${attempt.attemptId} revision conflict.`);
    }
    const next: SubscriptionMutationAttempt = {
      ...current,
      status,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
      ...(patch.evidence ? { evidence: patch.evidence } : {}),
      ...(patch.issue ? { issue: patch.issue } : {}),
    };
    await writeJsonAtomically(this.pathFor(attempt.attemptId), next);
    return next;
  }

  markDispatching(attempt: SubscriptionMutationAttempt): Promise<SubscriptionMutationAttempt> {
    if (attempt.status !== 'prepared') throw new Error('Only a prepared subscription mutation can dispatch.');
    return this.transition(attempt, 'dispatching');
  }

  confirm(
    attempt: SubscriptionMutationAttempt,
    evidence: SubscriptionManagementEvidence,
    status: 'confirmed' | 'already-satisfied' = 'confirmed',
  ): Promise<SubscriptionMutationAttempt> {
    if (attempt.status !== 'dispatching' && attempt.status !== 'prepared' && attempt.status !== 'ambiguous') {
      throw new Error('Only a prepared, dispatching, or ambiguous subscription mutation can be confirmed.');
    }
    if (evidence.platform !== attempt.intent.platform
      || evidence.savedSearchName !== attempt.intent.savedSearchName
      || evidence.expectedKeyword !== attempt.intent.expectedKeyword
      || evidence.conditionFingerprint !== attempt.intent.conditionFingerprint) {
      throw new Error('Subscription mutation evidence does not match its immutable intent.');
    }
    const { evidenceHash, ...unsignedEvidence } = evidence;
    if (hashSubscriptionMutationValue(unsignedEvidence) !== evidenceHash) {
      throw new Error('Subscription mutation evidence hash is invalid.');
    }
    return this.transition(attempt, status, { evidence });
  }

  markAmbiguous(attempt: SubscriptionMutationAttempt, issue: string): Promise<SubscriptionMutationAttempt> {
    if (attempt.status !== 'dispatching') throw new Error('Only a dispatching subscription mutation can become ambiguous.');
    return this.transition(attempt, 'ambiguous', { issue: normalizeText(issue, 'ambiguity issue') });
  }

  async reconcile(attemptId: string, evidence: SubscriptionManagementEvidence): Promise<SubscriptionMutationAttempt> {
    const attempt = await this.read(attemptId);
    if (attempt.status !== 'ambiguous') throw new Error('Only an ambiguous subscription mutation can be reconciled.');
    return this.confirm(attempt, evidence, 'confirmed');
  }
}

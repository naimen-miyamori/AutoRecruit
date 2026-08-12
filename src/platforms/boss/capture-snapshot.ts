import { createHash } from 'node:crypto';

import type { BossCaptureTaskSnapshot } from '../../types/job.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

/** Hashes immutable Boss capture facts; resolvedAt is audit metadata only. */
export function hashBossCaptureTaskSnapshot(
  snapshot: Omit<BossCaptureTaskSnapshot, 'snapshotHash'>,
): string {
  const { resolvedAt: _resolvedAt, ...behavior } = snapshot;
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(behavior)))
    .digest('hex');
}

export function assertBossCaptureTaskSnapshotHash(
  snapshot: BossCaptureTaskSnapshot,
): BossCaptureTaskSnapshot {
  const { snapshotHash, ...unsigned } = snapshot;
  if (!/^[a-f0-9]{64}$/u.test(snapshotHash)) {
    throw new Error('Boss capture task snapshotHash must be a SHA-256 hex digest.');
  }
  if (hashBossCaptureTaskSnapshot(unsigned) !== snapshotHash) {
    throw new Error('Boss capture task snapshot hash does not match its canonical content.');
  }
  return snapshot;
}

import { createHash } from 'node:crypto';
import type { CandidateListItem } from '../types/job.js';
import type { TalentMappingCorePlatform } from '../types/talent-mapping.js';

export function buildCandidateBatchIdentity(
  platform: TalentMappingCorePlatform,
  candidates: readonly CandidateListItem[],
  batchNumber?: number,
): string {
  const stableIds = candidates.map((candidate) => candidate.candidateId.trim());
  if (stableIds.some((candidateId) => !candidateId)) {
    throw new Error(`${platform} candidate batch contains an item without a stable candidateId`);
  }
  const fingerprint = createHash('sha256')
    .update([platform, batchNumber ?? '', stableIds.length, ...stableIds].join('\u001f'))
    .digest('hex');
  return `${platform}:${batchNumber ?? 'unknown'}:${fingerprint}`;
}

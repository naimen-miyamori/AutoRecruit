import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossCandidateRoutingArtifact,
  BossForwardingOutboxEntry,
  BossRejectionEmailOutboxEntry,
  CandidateResume,
  CandidateScoreArtifact,
  BossScreeningWorkItem,
} from '../types/job.js';

export interface BossCaptureHistoryAuditInput {
  seenIds: readonly string[];
  resumeFiles: readonly { fileCandidateId: string; resume: CandidateResume }[];
  scoreArtifacts: readonly CandidateScoreArtifact[];
  pendingScoreItems: readonly BossScreeningWorkItem[];
  routingArtifacts: readonly BossCandidateRoutingArtifact[];
  outboxEntries: readonly BossForwardingOutboxEntry[];
  rejectionEmailEntries?: readonly BossRejectionEmailOutboxEntry[];
}

export interface BossCaptureHistoryAuditAnomaly {
  code:
    | 'duplicate-seen-id'
    | 'invalid-seen-id'
    | 'seen-without-resume'
    | 'resume-file-id-mismatch'
    | 'duplicate-resume-id'
    | 'score-without-resume'
    | 'pending-score-without-resume'
    | 'pending-score-with-outbox'
    | 'routing-without-resume'
    | 'outbox-without-routing'
    | 'routing-policy-mismatch'
    | 'outbox-policy-mismatch'
    | 'outbox-audience-mismatch'
    | 'rejection-email-without-routing'
    | 'rejection-email-without-resume'
    | 'rejection-email-audience-mismatch';
  count: number;
  candidateIdsHash?: string;
}

export interface BossCaptureHistoryAuditSummary {
  jobKey: string;
  seenCount: number;
  resumeCount: number;
  scoreCount: number;
  pendingScoreCount: number;
  routingCount: number;
  outboxCount: number;
  rejectionEmailOutboxCount: number;
  anomalies: BossCaptureHistoryAuditAnomaly[];
}

function hashCandidateIds(candidateIds: readonly string[]): string | undefined {
  const values = [...new Set(candidateIds)].sort();
  if (values.length === 0) return undefined;
  return createHash('sha256').update(values.join('\n')).digest('hex');
}

function anomaly(
  code: BossCaptureHistoryAuditAnomaly['code'],
  candidateIds: readonly string[],
): BossCaptureHistoryAuditAnomaly | undefined {
  if (candidateIds.length === 0) return undefined;
  return {
    code,
    count: new Set(candidateIds).size,
    candidateIdsHash: hashCandidateIds(candidateIds),
  };
}

export function auditBossCaptureHistory(
  jobKey: string,
  input: BossCaptureHistoryAuditInput,
): BossCaptureHistoryAuditSummary {
  const seen = [...input.seenIds];
  const seenSet = new Set(seen);
  const resumesById = new Map<string, CandidateResume>();
  const resumeFileIdMismatches: string[] = [];
  const duplicateResumeIds: string[] = [];
  for (const item of input.resumeFiles) {
    if (item.fileCandidateId !== item.resume.candidateId) {
      resumeFileIdMismatches.push(item.fileCandidateId);
    }
    if (resumesById.has(item.resume.candidateId)) {
      duplicateResumeIds.push(item.resume.candidateId);
    }
    resumesById.set(item.resume.candidateId, item.resume);
  }

  const routingByCandidateId = new Map<string, BossCandidateRoutingArtifact>();
  const routingPolicyMismatches: string[] = [];
  for (const artifact of input.routingArtifacts) {
    const existing = routingByCandidateId.get(artifact.candidateId);
    if (existing && existing.policyHash !== artifact.policyHash) {
      routingPolicyMismatches.push(artifact.candidateId);
    }
    routingByCandidateId.set(artifact.candidateId, artifact);
  }
  const outboxByCandidateId = new Map<string, BossForwardingOutboxEntry>();
  const rejectionEmailEntries = input.rejectionEmailEntries ?? [];
  const outboxPolicyMismatches: string[] = [];
  const outboxAudienceMismatches: string[] = [];
  for (const entry of input.outboxEntries) {
    const existing = outboxByCandidateId.get(entry.candidateId);
    if (existing && existing.policyHash !== entry.policyHash) {
      outboxPolicyMismatches.push(entry.candidateId);
    }
    outboxByCandidateId.set(entry.candidateId, entry);
  }
  for (const entry of input.outboxEntries) {
    const routing = routingByCandidateId.get(entry.candidateId);
    if (routing && routing.policyHash !== entry.policyHash) {
      outboxPolicyMismatches.push(entry.candidateId);
    }
    if (routing && (routing.classification !== entry.classification || routing.audience !== entry.audience)) {
      outboxAudienceMismatches.push(entry.candidateId);
    }
  }

  const anomalies = [
    anomaly('duplicate-seen-id', seen.filter((id, index) => seen.indexOf(id) !== index)),
    anomaly('invalid-seen-id', seen.filter((id) => !id.trim())),
    anomaly('seen-without-resume', seen.filter((id) => !resumesById.has(id))),
    anomaly('resume-file-id-mismatch', resumeFileIdMismatches),
    anomaly('duplicate-resume-id', duplicateResumeIds),
    anomaly('score-without-resume', input.scoreArtifacts
      .map((artifact) => artifact.candidateId)
      .filter((id) => !resumesById.has(id))),
    anomaly('pending-score-without-resume', input.pendingScoreItems
      .map((item) => item.candidateId)
      .filter((id) => !resumesById.has(id))),
    anomaly('pending-score-with-outbox', input.pendingScoreItems
      .map((item) => item.candidateId)
      .filter((id) => outboxByCandidateId.has(id))),
    anomaly('routing-without-resume', input.routingArtifacts
      .map((artifact) => artifact.candidateId)
      .filter((id) => !resumesById.has(id))),
    anomaly('outbox-without-routing', input.outboxEntries
      .map((entry) => entry.candidateId)
      .filter((id) => !routingByCandidateId.has(id))),
    anomaly('routing-policy-mismatch', routingPolicyMismatches),
    anomaly('outbox-policy-mismatch', outboxPolicyMismatches),
    anomaly('outbox-audience-mismatch', outboxAudienceMismatches),
    anomaly('rejection-email-without-routing', rejectionEmailEntries
      .map((entry) => entry.candidateId)
      .filter((id) => !routingByCandidateId.has(id))),
    anomaly('rejection-email-without-resume', rejectionEmailEntries
      .map((entry) => entry.candidateId)
      .filter((id) => !resumesById.has(id))),
    anomaly('rejection-email-audience-mismatch', rejectionEmailEntries
      .map((entry) => entry.candidateId)
      .filter((id) => {
        const routing = routingByCandidateId.get(id);
        return routing !== undefined
          && (routing.classification !== 'rejected' || routing.audience !== 'secondary');
      })),
  ].filter((value): value is BossCaptureHistoryAuditAnomaly => Boolean(value));

  return {
    jobKey,
    seenCount: seenSet.size,
    resumeCount: resumesById.size,
    scoreCount: input.scoreArtifacts.length,
    pendingScoreCount: input.pendingScoreItems.length,
    routingCount: input.routingArtifacts.length,
    outboxCount: input.outboxEntries.length,
    rejectionEmailOutboxCount: rejectionEmailEntries.length,
    anomalies,
  };
}

async function listResumeFiles(jobKey: string): Promise<{ fileCandidateId: string; resume: CandidateResume }[]> {
  const resumesDir = path.join(config.dataDir, 'boss', 'jobs', jobKey, 'resumes');
  let files: string[];
  try {
    files = (await readdir(resumesDir)).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const store = new JobStore();
  const resumes = await store.listStoredResumes('boss', jobKey);
  const resumeById = new Map(resumes.map((resume) => [resume.candidateId, resume]));
  return files.map((file) => {
    const fileCandidateId = file.slice(0, -'.json'.length);
    const resume = resumeById.get(fileCandidateId);
    if (!resume) {
      return {
        fileCandidateId,
        resume: { candidateId: `__missing__${fileCandidateId}` } as CandidateResume,
      };
    }
    return { fileCandidateId, resume };
  });
}

async function run(jobKey: string): Promise<void> {
  const store = new JobStore();
  const [seenIds, resumeFiles, scoreArtifacts, pendingScoreItems, routingArtifacts, outboxEntries, rejectionEmailEntries] = await Promise.all([
    store.readSeenIds('boss', jobKey),
    listResumeFiles(jobKey),
    store.listStoredScoreArtifacts('boss', jobKey),
    store.listBossScreeningWorkItems('boss', jobKey),
    store.listBossCandidateRoutingArtifacts('boss', jobKey),
    store.listBossForwardingOutboxEntries('boss', jobKey),
    store.listBossRejectionEmailOutboxEntries('boss', jobKey),
  ]);
  const summary = auditBossCaptureHistory(jobKey, {
    seenIds,
    resumeFiles,
    scoreArtifacts,
    pendingScoreItems,
    routingArtifacts,
    outboxEntries,
    rejectionEmailEntries,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.anomalies.length > 0) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const jobKey = process.argv.slice(2).reduce<string | undefined>((value, arg, index, argv) => {
    if (arg === '--job-key') return argv[index + 1];
    return value;
  }, undefined)?.trim();

  if (!jobKey) {
    console.error('Usage: npm run audit:boss-capture-history -- --job-key <job-key>');
    process.exitCode = 1;
  } else {
    run(jobKey).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

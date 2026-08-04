import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditBossCaptureHistory } from './audit-boss-capture-history.js';
import type {
  BossCandidateRoutingArtifact,
  BossForwardingOutboxEntry,
  BossScreeningWorkItem,
  CandidateResume,
  CandidateScoreArtifact,
} from '../types/job.js';

function resume(candidateId: string): CandidateResume {
  return {
    candidateId,
    regions: [],
    pr: [],
    workExperiences: [],
    projectExperiences: [],
    educationExperiences: [],
    skill: [],
    certificates: [],
  };
}

function score(candidateId: string): CandidateScoreArtifact {
  return {
    candidateId,
    model: 'test-model',
    scoredAt: '2026-08-01T00:00:00.000Z',
    status: 'failed',
    error: 'test',
  };
}

function routing(candidateId: string, policyHash = 'policy-a'): BossCandidateRoutingArtifact {
  return {
    candidateId,
    fetchedAt: '2026-08-01T00:00:00.000Z',
    decidedAt: '2026-08-01T00:00:01.000Z',
    policyHash,
    scoreStatus: 'failed',
    classification: 'review',
    audience: 'primary',
    requirementEvaluations: [],
    matchedRequirementIds: [],
    unknownRequirementIds: [],
    reason: 'test',
    forwarding: {
      status: 'sent',
      mode: 'email',
      recipient: 'primary@example.com',
    },
  };
}

function outbox(candidateId: string, policyHash = 'policy-a'): BossForwardingOutboxEntry {
  return {
    candidateId,
    policyHash,
    classification: 'review',
    audience: 'primary',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:01.000Z',
    forwarding: {
      status: 'sent',
      mode: 'email',
      recipient: 'primary@example.com',
    },
  };
}

describe('Boss capture history audit', () => {
  it('accepts a captured candidate whose cross-file identities are consistent', () => {
    const summary = auditBossCaptureHistory('job-a', {
      seenIds: ['candidate-1'],
      resumeFiles: [{ fileCandidateId: 'candidate-1', resume: resume('candidate-1') }],
      scoreArtifacts: [score('candidate-1')],
      pendingScoreItems: [],
      routingArtifacts: [routing('candidate-1')],
      outboxEntries: [outbox('candidate-1')],
      rejectionEmailEntries: [],
    });
    assert.deepEqual(summary.anomalies, []);
    assert.deepEqual(summary, {
      jobKey: 'job-a',
      seenCount: 1,
      resumeCount: 1,
      scoreCount: 1,
      pendingScoreCount: 0,
      routingCount: 1,
      outboxCount: 1,
      rejectionEmailOutboxCount: 0,
      anomalies: [],
    });
  });

  it('reports identity gaps and cross-stage contradictions without mutating input', () => {
    const pending: BossScreeningWorkItem = {
      candidateId: 'candidate-4',
      policyHash: 'policy-a',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const summary = auditBossCaptureHistory('job-b', {
      seenIds: ['candidate-1', 'candidate-2', 'candidate-2'],
      resumeFiles: [{ fileCandidateId: 'candidate-1', resume: resume('wrong-id') }],
      scoreArtifacts: [score('candidate-3')],
      pendingScoreItems: [pending],
      routingArtifacts: [routing('candidate-5'), routing('candidate-6', 'policy-b'), routing('candidate-7')],
      outboxEntries: [outbox('candidate-4'), outbox('candidate-6', 'policy-a'), {
        ...outbox('candidate-7'),
        classification: 'rejected',
        audience: 'secondary',
      }],
    });
    assert.deepEqual(summary.anomalies.map((item) => item.code), [
      'duplicate-seen-id',
      'seen-without-resume',
      'resume-file-id-mismatch',
      'score-without-resume',
      'pending-score-without-resume',
      'pending-score-with-outbox',
      'routing-without-resume',
      'outbox-without-routing',
      'outbox-policy-mismatch',
      'outbox-audience-mismatch',
    ]);
  });
});

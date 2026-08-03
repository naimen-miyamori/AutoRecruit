import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import {
  assertBossScreeningJobRecordReady,
  BOSS_SCREENING_RESUME_INPUT_MAX_CHARS,
  buildBossScreeningResumeInput,
  buildBossScreeningResumeInputJson,
  buildBossScreeningScorePrompt,
  completeBossScreeningJsonRef,
  createBossCaptureSettingsSnapshot,
  extractBossScreeningScoreFromTextResponse,
  hashBossScreeningPolicy,
  loadBossScreeningPolicyFile,
  normalizeBossCaptureSettingsSnapshot,
  normalizeBossScreeningSettings,
  normalizePostScoreRoutingSettings,
  hashPostScoreRoutingPolicy,
  resolveBossRoutingDecision,
  scoreAndEvaluateBossScreening,
} from '../scoring/boss-screening.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossCandidateRoutingArtifact,
  BossForwardingOutboxEntry,
  BossModelRequirementEvaluation,
  BossScreeningSettings,
  CandidateRoutingArtifact,
  CandidateResume,
  CandidateScoreArtifact,
  CandidateScoreSuccessArtifact,
  JobRecord,
  NormalizedJob,
} from '../types/job.js';
import type { OpenAITextCompletionRequest } from '../llm/openai-client.js';

const job: NormalizedJob = {
  title: '全铝箱包设计',
  majors: [],
  languageRequirements: [],
  responsibilities: [],
  hardRequirements: [],
  preferredRequirements: [],
  regionPreferences: [],
  industryTags: [],
};

const resume: CandidateResume = {
  candidateId: 'boss-candidate-1',
  name: '测试候选人',
  age: 36,
  regions: ['广东'],
  pr: [],
  workExperiences: [],
  projectExperiences: [],
  educationExperiences: [],
  skill: [],
  certificates: [],
};

const genericBoxResume: CandidateResume = {
  ...resume,
  candidateId: 'generic-box-candidate',
  workExperiences: [{
    company: '箱包公司',
    title: '箱包设计师',
    details: ['负责PU及真皮箱包设计。'],
  }],
};

const aluminumResume: CandidateResume = {
  ...resume,
  candidateId: 'aluminum-luggage-candidate',
  projectExperiences: [{
    name: '铝合金行李箱结构设计',
    details: ['负责铝合金行李箱结构设计、打样和量产工艺。'],
  }],
};

function modelRequirement(overrides: Partial<BossScreeningSettings['requirements'][number]> = {}) {
  return {
    id: 'aluminum-luggage-experience',
    enabled: true,
    kind: 'modelRequirement' as const,
    requirement: '候选人具有铝制或铝合金箱包/行李箱相关设计、结构、工艺或量产经验。',
    criteria: [
      '材料与箱包或行李箱在同一工作、项目或产品语境中明确关联。',
      '体现实际设计、结构、工艺、打样或量产工作。',
    ],
    insufficientEvidence: [
      '仅出现箱包、皮具、女包、公司名称或岗位名称。',
      '仅有与箱包无关的铝材经验。',
    ],
    ...overrides,
  };
}

function screening(overrides: Partial<BossScreeningSettings> = {}): BossScreeningSettings {
  return {
    enabled: true,
    policyVersion: 2,
    decisionMode: 'reject-on-any-missing',
    requirements: [modelRequirement()],
    secondaryForwarding: { mode: 'email', recipient: 'secondary@example.test' },
    secondaryDelivery: { recipientEmail: 'secondary-report@example.test', ccEmails: ['review@example.test'] },
    ...overrides,
  };
}

function successArtifact(candidate = resume, totalScore = 80): CandidateScoreSuccessArtifact {
  return {
    candidateId: candidate.candidateId,
    model: 'test-model',
    scoredAt: '2026-07-31T01:02:03.000Z',
    status: 'success',
    score: {
      totalScore,
      dimensionScores: {
        education: { score: 80, reason: '学历信息明确。' },
        language: { score: 80, reason: '语言信息明确。' },
        experience: { score: 80, reason: '经历信息明确。' },
        industryMatch: { score: 80, reason: '行业信息明确。' },
        regionMatch: { score: 80, reason: '地区信息明确。' },
        responsibilityMatch: { score: 80, reason: '职责信息明确。' },
      },
      risks: [],
      summary: '测试评分。',
    },
  };
}

function evaluation(
  requirementId: string,
  outcome: BossModelRequirementEvaluation['outcome'],
  evidence: string[] = outcome === 'unknown' ? [] : ['铝合金行李箱结构设计'],
  missingCriteria: string[] = outcome === 'missing' ? ['材料与产品关联'] : [],
): BossModelRequirementEvaluation {
  return { requirementId, outcome, evidence, missingCriteria, reason: '测试模型评估。' };
}

function screeningResponse(input: {
  totalScore: number;
  evaluations: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    ...successArtifact().score,
    requirementEvaluations: input.evaluations,
  });
}

describe('Boss screening policy normalization', () => {
  it('normalizes version 2 model requirements and hashes only enabled business fields', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-screening-policy-'));
    try {
      const policyPath = path.join(tempDir, 'policy.json');
      await fs.writeFile(policyPath, JSON.stringify({
        version: 2,
        decisionMode: 'reject-on-any-missing',
        requirements: [
          { ...modelRequirement(), id: ' requirement-1 ', label: '  要求  ' },
          { ...modelRequirement({ id: 'disabled', enabled: false }), label: '禁用' },
        ],
      }), 'utf8');

      const loaded = await loadBossScreeningPolicyFile(policyPath);
      assert.equal(loaded.version, 2);
      assert.equal(loaded.decisionMode, 'reject-on-any-missing');
      assert.deepEqual(loaded.requirements[0], {
        ...modelRequirement(),
        id: 'requirement-1',
        label: '要求',
      });

      const first = normalizeBossScreeningSettings({ ...screening(), requirements: loaded.requirements });
      const second = normalizeBossScreeningSettings({
        ...first,
        requirements: [{ ...first.requirements[0]!, label: '改名不影响判定' }, first.requirements[1]!],
      });
      assert.equal(hashBossScreeningPolicy(first), hashBossScreeningPolicy(second));
      assert.throws(() => normalizeBossScreeningSettings({
        enabled: true,
        policyVersion: 1,
        decisionMode: 'reject-on-any-missing',
        requirements: [],
      }), /Invalid Boss screening settings/);
      assert.throws(() => normalizeBossScreeningSettings({
        enabled: true,
        policyVersion: 2,
        decisionMode: 'reject-on-any-missing',
        requirements: [{ id: 'old', enabled: true, kind: 'resumeMissingKeywords', keywords: ['箱包'] }],
      }), /Invalid Boss screening settings/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('requires all primary and secondary targets before an enabled job can execute', () => {
    const record: JobRecord = {
      jobKey: 'boss-screening-ready',
      platform: 'boss',
      searchKeyword: '全铝箱包设计',
      rawText: 'JD',
      normalizedJob: job,
      createdAt: '2026-07-31T00:00:00.000Z',
      bossScreening: normalizeBossScreeningSettings(screening()),
    };
    assert.throws(() => assertBossScreeningJobRecordReady(record), /primary bossForwarding/);

    record.bossForwarding = { mode: 'colleague', recipient: '主收件人' };
    record.recipientEmail = 'primary-report@example.test';
    assert.doesNotThrow(() => assertBossScreeningJobRecordReady(record));
  });

  it('normalizes secondary email forwarding CC and rejects it for colleague forwarding', () => {
    const normalized = normalizeBossScreeningSettings(screening({
      secondaryForwarding: {
        mode: 'email',
        recipient: ' secondary@example.test ',
        ccEmails: [' audit@example.test ', 'audit@example.test'],
      },
    }));
    assert.deepEqual(normalized.secondaryForwarding, {
      mode: 'email',
      recipient: 'secondary@example.test',
      ccEmails: ['audit@example.test'],
    });
    assert.throws(() => normalizeBossScreeningSettings(screening({
      secondaryForwarding: {
        mode: 'colleague',
        recipient: '招聘同事',
        ccEmails: ['audit@example.test'],
      },
    })), /ccEmails can only be used with email forwarding/);
  });

  it('creates a version 2 hash-protected exact queue snapshot', async () => {
    const record: JobRecord = {
      jobKey: 'boss-screening-snapshot',
      platform: 'boss',
      searchKeyword: '全铝箱包设计',
      rawText: 'JD',
      normalizedJob: job,
      createdAt: '2026-08-01T00:00:00.000Z',
      recipientEmail: 'primary-report@example.test',
      ccEmails: ['primary-report-audit@example.test'],
      bossForwarding: { mode: 'email', recipient: 'primary-forward@example.test' },
      bossScreening: screening({
        secondaryForwarding: { mode: 'email', recipient: 'secondary-forward@example.test' },
        secondaryDelivery: { recipientEmail: 'secondary-report@example.test' },
      }),
    };
    const snapshot = await createBossCaptureSettingsSnapshot({
      overrides: {},
      existingJobRecord: record,
      resolvedAt: '2026-08-01T00:01:00.000Z',
      sourceJobKey: record.jobKey,
    });
    assert.equal(snapshot.version, 2);
    assert.deepEqual(snapshot.primaryForwarding, {
      mode: 'email',
      recipient: 'primary-forward@example.test',
      ccEmails: [],
    });
    assert.deepEqual(snapshot.primaryDelivery.ccEmails, ['primary-report-audit@example.test']);
    assert.deepEqual(snapshot.screening?.requirements[0]?.criteria.length, 2);
    assert.deepEqual(normalizeBossCaptureSettingsSnapshot(snapshot), snapshot);
    assert.throws(() => normalizeBossCaptureSettingsSnapshot({
      ...snapshot,
      primaryForwarding: { ...snapshot.primaryForwarding!, recipient: 'tampered@example.test' },
    }), /snapshot hash does not match/);
  });
});

describe('Boss model requirement evaluation', () => {
  it('uses every structured resume detail without compact-summary truncation', () => {
    const longWorkDetails = Array.from({ length: 8 }, (_, index) => `工作细节-${index + 1}`);
    const longResume: CandidateResume = {
      ...aluminumResume,
      workExperiences: [{ company: '全铝箱包工厂', title: '结构设计', details: longWorkDetails }],
      projectExperiences: [{ name: '行李箱项目', details: ['项目细节-1', '项目细节-2', '项目细节-3', '项目细节-4'] }],
      educationExperiences: [{ school: '设计学院', details: ['教育细节-1', '教育细节-2', '教育细节-3'] }],
    };

    const canonical = buildBossScreeningResumeInput(longResume);
    assert.equal(canonical.complete, true);
    assert.deepEqual(canonical.workExperiences[0]?.details, longWorkDetails);
    assert.deepEqual(canonical.projectExperiences[0]?.details, ['项目细节-1', '项目细节-2', '项目细节-3', '项目细节-4']);
    assert.deepEqual(canonical.educationExperiences[0]?.details, ['教育细节-1', '教育细节-2', '教育细节-3']);

    const prompt = JSON.parse(buildBossScreeningScorePrompt({ job, resume: longResume, policy: screening() })) as {
      input: { candidate: CandidateResume & { complete?: boolean } };
    };
    assert.equal(prompt.input.candidate.complete, true);
    assert.deepEqual(prompt.input.candidate.workExperiences[0]?.details, longWorkDetails);
  });

  it('verifies evidence against detail lines beyond the ordinary score summary limit', () => {
    const detailedResume: CandidateResume = {
      ...aluminumResume,
      workExperiences: [{
        company: '箱包工厂',
        title: '结构设计师',
        details: ['普通工作说明-1', '普通工作说明-2', '普通工作说明-3', '铝合金行李箱结构设计与量产-4'],
      }],
    };
    const parsed = extractBossScreeningScoreFromTextResponse(screeningResponse({
      totalScore: 83,
      evaluations: [{
        requirementId: 'aluminum-luggage-experience',
        outcome: 'satisfied',
        evidence: ['铝合金行李箱结构设计与量产-4'],
        missingCriteria: [],
        reason: '完整经历中有明确证据。',
      }],
    }), { job, resume: detailedResume, policy: screening() });
    assert.equal(parsed.evaluations[0]?.outcome, 'satisfied');
  });

  it('uses a stable canonical input hash and fails closed when the full input exceeds the budget', () => {
    const details = '超长简历详情'.repeat(Math.ceil(BOSS_SCREENING_RESUME_INPUT_MAX_CHARS / 3));
    const oversized: CandidateResume = {
      ...aluminumResume,
      workExperiences: [{ title: '设计师', details: [details] }],
    };
    assert.throws(() => buildBossScreeningResumeInputJson(oversized), /exceeds .* characters/);
    const first = buildBossScreeningResumeInputJson(aluminumResume);
    const second = buildBossScreeningResumeInputJson({ ...aluminumResume });
    assert.equal(first, second);
  });

  it('uses one schema-constrained completion and requires every model requirement', async () => {
    const original = completeBossScreeningJsonRef.fn;
    let request: OpenAITextCompletionRequest | undefined;
    try {
      completeBossScreeningJsonRef.fn = async (input) => {
        request = input;
        return screeningResponse({
          totalScore: 80,
          evaluations: [{
            requirementId: 'aluminum-luggage-experience',
            outcome: 'satisfied',
            evidence: ['铝合金行李箱结构设计'],
            missingCriteria: [],
            reason: '有明确相关经历。',
          }],
        });
      };
      const result = await scoreAndEvaluateBossScreening({ job, resume: aluminumResume, policy: screening() });
      assert.equal(result.score.totalScore, 80);
      assert.deepEqual(result.evaluations.map((item) => item.outcome), ['satisfied']);
      assert.equal(request?.completionRoute, config.scoring.completionRoute);
    } finally {
      completeBossScreeningJsonRef.fn = original;
    }
  });

  it('rejects generic box experience when the model says the aluminum requirement is missing', () => {
    const parsed = extractBossScreeningScoreFromTextResponse(screeningResponse({
      totalScore: 43,
      evaluations: [{
        requirementId: 'aluminum-luggage-experience',
        outcome: 'missing',
        evidence: ['PU及真皮箱包设计'],
        missingCriteria: ['材料与箱包或行李箱明确关联', '铝制或铝合金结构经验'],
        reason: '只有普通皮具箱包经历，未体现铝制产品。',
      }],
    }), { job, resume: genericBoxResume, policy: screening() });
    assert.equal(parsed.evaluations[0]?.outcome, 'missing');
    const decision = resolveBossRoutingDecision(successArtifact(genericBoxResume, 43), parsed.evaluations, screening());
    assert.equal(decision.classification, 'rejected');
    assert.equal(decision.audience, 'secondary');
  });

  it('accepts explicit aluminum luggage experience and verifies evidence literally', () => {
    const parsed = extractBossScreeningScoreFromTextResponse(screeningResponse({
      totalScore: 82,
      evaluations: [{
        requirementId: 'aluminum-luggage-experience',
        outcome: 'satisfied',
        evidence: ['铝合金行李箱结构设计', '量产工艺'],
        missingCriteria: [],
        reason: '材料、产品和实际工作均有明确证据。',
      }],
    }), { job, resume: aluminumResume, policy: screening() });
    assert.deepEqual(parsed.evaluations[0], {
      requirementId: 'aluminum-luggage-experience',
      outcome: 'satisfied',
      evidence: ['铝合金行李箱结构设计', '量产工艺'],
      missingCriteria: [],
      reason: '材料、产品和实际工作均有明确证据。',
    });
  });

  it('downgrades unverifiable satisfied and incomplete missing claims to unknown', () => {
    const satisfied = extractBossScreeningScoreFromTextResponse(screeningResponse({
      totalScore: 80,
      evaluations: [{
        requirementId: 'aluminum-luggage-experience',
        outcome: 'satisfied',
        evidence: ['模型自行推断的证据'],
        missingCriteria: [],
        reason: '模型说有证据。',
      }],
    }), { job, resume: aluminumResume, policy: screening() });
    assert.equal(satisfied.evaluations[0]?.outcome, 'unknown');

    const missing = extractBossScreeningScoreFromTextResponse(screeningResponse({
      totalScore: 80,
      evaluations: [{
        requirementId: 'aluminum-luggage-experience',
        outcome: 'missing',
        evidence: [],
        missingCriteria: [],
        reason: '没有给出缺失标准。',
      }],
    }), { job, resume: genericBoxResume, policy: screening() });
    assert.equal(missing.evaluations[0]?.outcome, 'unknown');
  });

  it('requires all requirement IDs and routes unknown to primary review', () => {
    assert.throws(() => extractBossScreeningScoreFromTextResponse(screeningResponse({
      totalScore: 80,
      evaluations: [],
    }), { job, resume, policy: screening() }), /omitted model requirement IDs/);

    const review = resolveBossRoutingDecision(successArtifact(), [evaluation(
      'aluminum-luggage-experience',
      'unknown',
    )], screening());
    assert.deepEqual(review, {
      classification: 'review',
      audience: 'primary',
      matchedRequirementIds: [],
      unknownRequirementIds: ['aluminum-luggage-experience'],
      reason: '模型要求证据不足，需人工复核：aluminum-luggage-experience。',
    });
  });
});

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-screening-store-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('JobStore Boss model screening facts', () => {
  it('persists normalized version 2 settings, immutable routing facts, and current outbox independently', async () => {
    const store = new JobStore();
    const jobKey = 'boss-routing-store';
    const record: JobRecord = {
      jobKey,
      platform: 'boss',
      searchKeyword: '全铝箱包设计',
      rawText: 'JD',
      normalizedJob: job,
      createdAt: '2026-07-31T00:00:00.000Z',
      recipientEmail: 'primary-report@example.test',
      bossForwarding: { mode: 'colleague', recipient: '主收件人' },
      bossScreening: screening(),
    };
    await store.saveJobRecord('boss', record);
    assert.deepEqual((await store.readJobRecord('boss', jobKey)).bossScreening, screening());

    const artifact: BossCandidateRoutingArtifact = {
      candidateId: resume.candidateId,
      fetchedAt: '2026-07-31T01:00:00.000Z',
      scoredAt: '2026-07-31T01:02:00.000Z',
      decidedAt: '2026-07-31T01:03:00.000Z',
      policyHash: 'policy-hash',
      scoreStatus: 'success',
      classification: 'review',
      audience: 'primary',
      requirementEvaluations: [evaluation('aluminum-luggage-experience', 'unknown')],
      matchedRequirementIds: [],
      unknownRequirementIds: ['aluminum-luggage-experience'],
      reason: '需复核。',
      forwarding: { status: 'pending', mode: 'colleague', recipient: '主收件人' },
    };
    const artifactPath = await store.saveBossCandidateRoutingArtifact('boss', jobKey, artifact);
    assert.match(artifactPath, /routing\/artifacts/);
    assert.deepEqual(await store.listBossCandidateRoutingArtifacts('boss', jobKey), [artifact]);

    const pending: BossForwardingOutboxEntry = {
      candidateId: resume.candidateId,
      policyHash: 'policy-hash',
      classification: 'review',
      audience: 'primary',
      createdAt: artifact.decidedAt,
      updatedAt: artifact.decidedAt,
      forwarding: { status: 'pending', mode: 'colleague', recipient: '主收件人' },
    };
    await store.saveBossForwardingOutboxEntry('boss', jobKey, pending);
    const sent: BossForwardingOutboxEntry = {
      ...pending,
      updatedAt: '2026-07-31T01:04:00.000Z',
      forwarding: {
        ...pending.forwarding,
        status: 'sent',
        attemptedAt: '2026-07-31T01:03:30.000Z',
        completedAt: '2026-07-31T01:04:00.000Z',
      },
    };
    await store.saveBossForwardingOutboxEntry('boss', jobKey, sent);
    assert.deepEqual(await store.readBossForwardingOutboxEntry('boss', jobKey, resume.candidateId), sent);
    assert.deepEqual(await store.listBossForwardingOutboxEntries('boss', jobKey), [sent]);
  });
});

describe('platform-neutral post-score routing', () => {
  it('does not require native forwarding and routes missing/unknown evidence safely', () => {
    const policy = normalizePostScoreRoutingSettings({
      enabled: true,
      policyVersion: 2,
      decisionMode: 'reject-on-any-missing',
      requirements: [modelRequirement()],
      secondaryDelivery: { recipientEmail: 'secondary-report@example.test' },
    });
    assert.equal(hashPostScoreRoutingPolicy(policy), hashBossScreeningPolicy(policy));
    const rejected = resolveBossRoutingDecision(successArtifact(genericBoxResume), [evaluation('aluminum-luggage-experience', 'missing')], policy);
    assert.deepEqual(rejected, {
      classification: 'rejected',
      audience: 'secondary',
      matchedRequirementIds: ['aluminum-luggage-experience'],
      unknownRequirementIds: [],
      reason: '模型明确判断以下要求缺失：aluminum-luggage-experience。',
    });
    const review = resolveBossRoutingDecision(successArtifact(), [evaluation('aluminum-luggage-experience', 'unknown')], policy);
    assert.equal(review.classification, 'review');
    assert.equal(review.audience, 'primary');
    assert.throws(() => normalizePostScoreRoutingSettings({
      enabled: true,
      policyVersion: 2,
      decisionMode: 'reject-on-any-missing',
      requirements: [modelRequirement()],
    }), /secondaryDelivery/);
  });

  it('persists generic routing artifacts and pending score work on a non-Boss platform', async () => {
    const store = new JobStore();
    const jobKey = 'generic-routing-store';
    const artifact: CandidateRoutingArtifact = {
      routingDecisionId: 'generic-decision-1',
      candidateId: '51job-candidate-1',
      fetchedAt: '2026-08-02T01:00:00.000Z',
      scoredAt: '2026-08-02T01:01:00.000Z',
      decidedAt: '2026-08-02T01:02:00.000Z',
      policyHash: 'generic-policy',
      scoreStatus: 'success',
      classification: 'qualified',
      audience: 'primary',
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '符合。',
    };
    await store.saveCandidateRoutingArtifact('51job', jobKey, artifact);
    await store.savePostScoreRoutingWorkItem('51job', jobKey, {
      candidateId: '51job-candidate-2',
      policyHash: 'generic-policy',
      createdAt: artifact.fetchedAt,
      updatedAt: artifact.fetchedAt,
    });
    assert.deepEqual(await store.listCandidateRoutingArtifacts('51job', jobKey), [artifact]);
    assert.deepEqual((await store.listPostScoreRoutingWorkItems('51job', jobKey)).map((item) => item.candidateId), ['51job-candidate-2']);
  });
});

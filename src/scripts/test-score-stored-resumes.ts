import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import { JobStore } from '../storage/job-store.js';
import type { CandidateResume, CandidateScore, JobRecord } from '../types/job.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-score-stored-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function importScoreStoredResumesModule() {
  const scriptPath = fileURLToPath(new URL('./score-stored-resumes.ts', import.meta.url));
  return import(`${pathToFileURL(scriptPath).href}?test=${Date.now()}-${Math.random()}`);
}

function assertValidScoreArtifactShape(artifact: Record<string, unknown>) {
  assert.equal('inputSummary' in artifact, false);
  assert.equal(typeof artifact.candidateId, 'string');
  assert.equal(typeof artifact.model, 'string');
  assert.equal(typeof artifact.scoredAt, 'string');

  if (artifact.status === 'success') {
    assert.equal('error' in artifact, false);
    assert.equal('score' in artifact, true);

    const score = artifact.score as Record<string, unknown>;
    assert.equal('candidateId' in score, false);
    assert.equal('matchedHighlights' in score, false);
    assert.equal(typeof score.totalScore, 'number');
    assert.equal(Array.isArray(score.risks), true);
    assert.equal(typeof score.summary, 'string');

    const dimensionScores = score.dimensionScores as Record<string, unknown>;
    for (const key of ['education', 'language', 'experience', 'industryMatch', 'regionMatch', 'responsibilityMatch']) {
      assert.equal(key in dimensionScores, true);
      const dimension = dimensionScores[key] as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(dimension).sort(), ['reason', 'score']);
      assert.equal(typeof dimension.score, 'number');
      assert.equal(typeof dimension.reason, 'string');
    }

    return;
  }

  assert.equal(artifact.status, 'failed');
  assert.equal(typeof artifact.error, 'string');
  assert.equal('score' in artifact, false);
}

describe('JobStore offline scoring readers', () => {
  it('reads the stored job record and stored resumes for a job key', async () => {
    const store = new JobStore();
    const jobKey = 'stored-score-job';
    const jobRecord: JobRecord = {
      jobKey,
      platform: '51job',
      searchKeyword: '通用阀华南营业经理',
      rawText: 'raw jd',
      normalizedJob: {
        title: '华南营业经理',
        location: '华南',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    const resume: CandidateResume = {
      candidateId: 'cand-1',
      name: '候选人A',
      regions: ['华南'],
      pr: [],
      workExperiences: [],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: [],
    };

    await store.saveJobRecord('51job', jobRecord);
    await store.saveCandidateResume('51job', jobKey, resume);

    const storedJobRecord = await store.readJobRecord('51job', jobKey);
    const resumes = await store.listStoredResumes('51job', jobKey);

    assert.deepStrictEqual(storedJobRecord, jobRecord);
    assert.deepStrictEqual(resumes, [resume]);
  });
});

describe('score-stored-resumes', () => {
  it('scores every stored resume and writes score artifacts', async () => {
    const store = new JobStore();
    const jobKey = 'stored-score-job';
    const jobRecord: JobRecord = {
      jobKey,
      platform: '51job',
      searchKeyword: '通用阀华南营业经理',
      rawText: 'raw jd',
      normalizedJob: {
        title: '华南营业经理',
        location: '华南',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-04-20T00:00:00.000Z',
    };

    const resumes: CandidateResume[] = [
      {
        candidateId: 'cand-1',
        name: '候选人A',
        regions: ['华南'],
        pr: ['8年经验'],
        workExperiences: [
          {
            company: '公司A',
            title: '销售经理',
            industry: '阀门',
            details: ['渠道销售'],
          },
        ],
        projectExperiences: [],
        educationExperiences: [],
        skill: [{ english: 'CET-4' }],
        certificates: ['PMP'],
      },
      {
        candidateId: 'cand-2',
        name: '候选人B',
        regions: ['华东'],
        pr: [],
        workExperiences: [],
        projectExperiences: [],
        educationExperiences: [],
        skill: [],
        certificates: [],
      },
    ];

    await store.saveJobRecord('51job', jobRecord);
    await Promise.all(resumes.map((resume) => store.saveCandidateResume('51job', jobKey, resume)));

    const module = await importScoreStoredResumesModule();
    const scored: string[] = [];

    module.scoreResumeAgainstJobRef.fn = async (_job: JobRecord['normalizedJob'], resume: CandidateResume): Promise<CandidateScore> => {
      scored.push(resume.candidateId);
      if (resume.candidateId === 'cand-2') {
        throw new Error('Synthetic scoring failure');
      }

      return {
        totalScore: 88,
        dimensionScores: {
          education: { score: 80, reason: '学历达标' },
          language: { score: 85, reason: '具备英语能力' },
          experience: { score: 90, reason: '销售经历较强' },
          industryMatch: { score: 87, reason: '阀门行业相关' },
          regionMatch: { score: 86, reason: '区域匹配' },
          responsibilityMatch: { score: 89, reason: '职责接近' },
        },
        risks: ['行业需确认'],
        summary: '整体匹配度较好',
      };
    };

    const result = await module.scoreStoredResumes('51job', jobKey);

    assert.deepStrictEqual(scored, ['cand-1', 'cand-2']);
    assert.deepStrictEqual(result, {
      jobKey,
      totalResumes: 2,
      scoredCandidates: ['cand-1'],
      failedCandidates: [{ candidateId: 'cand-2', error: 'Synthetic scoring failure' }],
    });

    const scoreDir = path.join(tempDir, '51job', 'jobs', jobKey, 'scores');
    const successArtifact = JSON.parse(await fs.readFile(path.join(scoreDir, 'cand-1.json'), 'utf8'));
    const failureArtifact = JSON.parse(await fs.readFile(path.join(scoreDir, 'cand-2.json'), 'utf8'));

    assert.equal(successArtifact.status, 'success');
    assert.equal(successArtifact.model, config.scoring.model);
    assert.deepStrictEqual(successArtifact.score, {
      totalScore: 88,
      dimensionScores: {
        education: { score: 80, reason: '学历达标' },
        language: { score: 85, reason: '具备英语能力' },
        experience: { score: 90, reason: '销售经历较强' },
        industryMatch: { score: 87, reason: '阀门行业相关' },
        regionMatch: { score: 86, reason: '区域匹配' },
        responsibilityMatch: { score: 89, reason: '职责接近' },
      },
      risks: ['行业需确认'],
      summary: '整体匹配度较好',
    });
    assert.equal(failureArtifact.status, 'failed');
    assert.equal(failureArtifact.model, config.scoring.model);
    assert.equal(failureArtifact.error, 'Synthetic scoring failure');

    assertValidScoreArtifactShape(successArtifact);
    assertValidScoreArtifactShape(failureArtifact);
  });

  it('writes artifacts that match the persisted score contract', async () => {
    const store = new JobStore();
    const jobKey = 'stored-score-contract';
    const successArtifact = {
      candidateId: 'cand-success',
      model: config.scoring.model,
      scoredAt: '2026-04-20T00:00:00.000Z',
      status: 'success' as const,
      score: {
        totalScore: 61,
        dimensionScores: {
          education: { score: 70, reason: '学历信息明确' },
          language: { score: 60, reason: '语言能力一般' },
          experience: { score: 65, reason: '相关经历有限' },
          industryMatch: { score: 55, reason: '行业相关性一般' },
          regionMatch: { score: 85, reason: '地区匹配' },
          responsibilityMatch: { score: 62, reason: '职责部分重合' },
        },
        risks: ['需进一步确认行业经验'],
        summary: '整体中等匹配。',
      },
    };
    const failureArtifact = {
      candidateId: 'cand-failed',
      model: config.scoring.model,
      scoredAt: '2026-04-20T00:00:01.000Z',
      status: 'failed' as const,
      error: 'Synthetic scoring failure',
    };

    await store.saveCandidateScoreArtifact('51job', jobKey, successArtifact);
    await store.saveCandidateScoreArtifact('51job', jobKey, failureArtifact);

    const scoreDir = path.join(tempDir, '51job', 'jobs', jobKey, 'scores');
    const artifacts = await Promise.all(
      ['cand-success.json', 'cand-failed.json'].map(async (fileName) =>
        JSON.parse(await fs.readFile(path.join(scoreDir, fileName), 'utf8')) as Record<string, unknown>,
      ),
    );

    artifacts.forEach(assertValidScoreArtifactShape);
  });

  it('fails when a job key has no stored resumes', async () => {
    const store = new JobStore();
    const jobKey = 'empty-job';
    const jobRecord: JobRecord = {
      jobKey,
      platform: '51job',
      searchKeyword: 'empty',
      rawText: 'raw jd',
      normalizedJob: {
        title: 'Empty',
        location: '',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-04-20T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', jobRecord);

    const module = await importScoreStoredResumesModule();

    await assert.rejects(() => module.scoreStoredResumes('51job', jobKey), /No stored resumes found for job key empty-job/);
  });
});

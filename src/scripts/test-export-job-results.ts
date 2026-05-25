import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { config } from '../config.js';
import { exportJobResults } from './export-job-results.js';
import { JobStore } from '../storage/job-store.js';
import type { CandidateScoreArtifact, JobRecord, RunResult } from '../types/job.js';

const createdJobKeys: string[] = [];

function buildJobPath(platform: '51job' | 'liepin', jobKey: string, ...segments: string[]): string {
  return path.join(config.dataDir, platform, 'jobs', jobKey, ...segments);
}

async function cleanupJob(jobKey: string): Promise<void> {
  await fs.rm(buildJobPath('51job', jobKey), { recursive: true, force: true });
  await fs.rm(buildJobPath('liepin', jobKey), { recursive: true, force: true });
}

async function seedJobData(
  jobKey: string,
  options: {
    artifacts?: CandidateScoreArtifact[];
    runResults?: RunResult[];
  } = {},
): Promise<{ expectedPath: string }> {
  const store = new JobStore();
  const jobRecord: JobRecord = {
    jobKey,
    platform: '51job',
    searchKeyword: '东南亚 销售',
    rawText: 'raw jd',
    normalizedJob: {
      title: '东南亚销售经理',
      majors: [],
      languageRequirements: [],
      responsibilities: [],
      hardRequirements: [],
      preferredRequirements: [],
      regionPreferences: [],
      industryTags: [],
    },
    createdAt: '2026-04-21T00:00:00.000Z',
  };
  const defaultArtifact: CandidateScoreArtifact = {
    candidateId: 'cand-1',
    model: 'claude-test',
    scoredAt: '2026-04-21T00:00:01.000Z',
    status: 'success',
    score: {
      totalScore: 88,
      dimensionScores: {
        education: { score: 88, reason: 'ok' },
        language: { score: 88, reason: 'ok' },
        experience: { score: 88, reason: 'ok' },
        industryMatch: { score: 88, reason: 'ok' },
        regionMatch: { score: 88, reason: 'ok' },
        responsibilityMatch: { score: 88, reason: 'ok' },
      },
      risks: [],
      summary: 'good fit for export verification with a deliberately longer overview summary string',
    },
  };
  const artifacts = options.artifacts ?? [defaultArtifact];
  const runResults = options.runResults ?? [
    {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-21T00:00:02.000Z',
      totalCandidates: artifacts.length,
      newCandidateIds: artifacts.map((artifact) => artifact.candidateId),
      scoredCandidates: artifacts
        .filter((artifact) => artifact.status === 'success')
        .map((artifact) => artifact.candidateId),
      failedCandidates: artifacts
        .filter((artifact) => artifact.status === 'failed')
        .map((artifact) => ({ candidateId: artifact.candidateId, error: artifact.error })),
    },
  ];

  await cleanupJob(jobKey);
  createdJobKeys.push(jobKey);
  await store.saveJobRecord('51job', jobRecord);
  await Promise.all(artifacts.map((artifact) => store.saveCandidateScoreArtifact('51job', jobKey, artifact)));
  await Promise.all(runResults.map((runResult) => store.saveRunResult('51job', jobKey, runResult)));

  return {
    expectedPath: buildJobPath('51job', jobKey, 'exports', 'latest.md'),
  };
}

after(async () => {
  await Promise.all(createdJobKeys.map((jobKey) => cleanupJob(jobKey)));
});

describe('exportJobResults', () => {
  it('writes exports/latest.md via saveJobExport', async () => {
    const jobKey = `job-save-export-${Date.now()}`;
    createdJobKeys.push(jobKey);
    await cleanupJob(jobKey);

    const store = new JobStore();
    const markdown = '# Export Role 评分结果\n\n- candidateCount: 0\n';

    const exportPath = await store.saveJobExport('51job', jobKey, markdown);

    assert.equal(exportPath, buildJobPath('51job', jobKey, 'exports', 'latest.md'));
    const persisted = await fs.readFile(exportPath, 'utf8');
    assert.equal(persisted, markdown);
  });

  it('writes exports under the requested platform directory', async () => {
    const jobKey = `job-platform-export-${Date.now()}`;
    const store = new JobStore();
    const markdown = '# Platform Export\n';

    const exportPath = await store.saveJobExport('liepin', jobKey, markdown);

    assert.equal(exportPath, buildJobPath('liepin', jobKey, 'exports', 'latest.md'));
    assert.equal(await fs.readFile(exportPath, 'utf8'), markdown);
  });

  it('aggregates stored score data and returns persisted export summary', async () => {
    const jobKey = `job-export-script-${Date.now()}`;
    const { expectedPath } = await seedJobData(jobKey);

    const result = await exportJobResults('51job', jobKey);

    assert.equal(result.jobKey, jobKey);
    assert.equal(result.exportPath, expectedPath);
    assert.deepStrictEqual(result.summary, {
      candidateCount: 1,
      successCount: 1,
      failureCount: 0,
    });

    const persisted = await fs.readFile(expectedPath, 'utf8');
    assert.match(persisted, /## 候选人速览/);
    assert.match(persisted, /- 1\. cand-1 — 88\n  - 摘要: good fit for export verification with a deliberately longer overview summary string/);
    assert.match(persisted, /- 摘要: good fit for export verification with a deliberately longer overview summary string/);
    assert.doesNotMatch(persisted, /## 评分失败|无。|- 模型: /);
    assert.doesNotMatch(persisted, /latest\.json|totalResumes|unscoredCount|regions|pr/);
  });

  it('exports only candidates from the latest persisted run', async () => {
    const jobKey = `job-export-latest-run-${Date.now()}`;
    const { expectedPath } = await seedJobData(jobKey, {
      artifacts: [
        {
          candidateId: 'cand-old',
          model: 'claude-test',
          scoredAt: '2026-04-20T00:00:01.000Z',
          status: 'success',
          score: {
            totalScore: 71,
            dimensionScores: {
              education: { score: 71, reason: 'old' },
              language: { score: 71, reason: 'old' },
              experience: { score: 71, reason: 'old' },
              industryMatch: { score: 71, reason: 'old' },
              regionMatch: { score: 71, reason: 'old' },
              responsibilityMatch: { score: 71, reason: 'old' },
            },
            risks: [],
            summary: 'historical candidate summary should not export',
          },
        },
        {
          candidateId: 'cand-new',
          model: 'claude-test',
          scoredAt: '2026-04-21T00:00:01.000Z',
          status: 'success',
          score: {
            totalScore: 93,
            dimensionScores: {
              education: { score: 93, reason: 'latest' },
              language: { score: 93, reason: 'latest' },
              experience: { score: 93, reason: 'latest' },
              industryMatch: { score: 93, reason: 'latest' },
              regionMatch: { score: 93, reason: 'latest' },
              responsibilityMatch: { score: 93, reason: 'latest' },
            },
            risks: [],
            summary: 'latest run candidate should export',
          },
        },
      ],
      runResults: [
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-20T00:00:02.000Z',
          totalCandidates: 1,
          newCandidateIds: ['cand-old'],
          scoredCandidates: ['cand-old'],
          failedCandidates: [],
        },
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-21T00:00:02.000Z',
          totalCandidates: 1,
          newCandidateIds: ['cand-new'],
          scoredCandidates: ['cand-new'],
          failedCandidates: [],
        },
      ],
    });

    const result = await exportJobResults('51job', jobKey);

    assert.deepStrictEqual(result.summary, {
      candidateCount: 1,
      successCount: 1,
      failureCount: 0,
    });

    const persisted = await fs.readFile(expectedPath, 'utf8');
    assert.match(persisted, /cand-new/);
    assert.doesNotMatch(persisted, /cand-old/);
    assert.doesNotMatch(persisted, /historical candidate summary should not export/);
  });

  it('includes latest-run failed candidates when failure artifacts exist', async () => {
    const jobKey = `job-export-latest-failure-${Date.now()}`;
    const { expectedPath } = await seedJobData(jobKey, {
      artifacts: [
        {
          candidateId: 'cand-success',
          model: 'claude-test',
          scoredAt: '2026-04-21T00:00:01.000Z',
          status: 'success',
          score: {
            totalScore: 85,
            dimensionScores: {
              education: { score: 85, reason: 'ok' },
              language: { score: 85, reason: 'ok' },
              experience: { score: 85, reason: 'ok' },
              industryMatch: { score: 85, reason: 'ok' },
              regionMatch: { score: 85, reason: 'ok' },
              responsibilityMatch: { score: 85, reason: 'ok' },
            },
            risks: [],
            summary: 'latest success candidate should export',
          },
        },
        {
          candidateId: 'cand-failed',
          model: 'claude-test',
          scoredAt: '2026-04-21T00:00:03.000Z',
          status: 'failed',
          error: 'model timeout',
        },
        {
          candidateId: 'cand-older',
          model: 'claude-test',
          scoredAt: '2026-04-20T00:00:01.000Z',
          status: 'success',
          score: {
            totalScore: 60,
            dimensionScores: {
              education: { score: 60, reason: 'old' },
              language: { score: 60, reason: 'old' },
              experience: { score: 60, reason: 'old' },
              industryMatch: { score: 60, reason: 'old' },
              regionMatch: { score: 60, reason: 'old' },
              responsibilityMatch: { score: 60, reason: 'old' },
            },
            risks: [],
            summary: 'old success should not export',
          },
        },
      ],
      runResults: [
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-20T00:00:02.000Z',
          totalCandidates: 1,
          newCandidateIds: ['cand-older'],
          scoredCandidates: ['cand-older'],
          failedCandidates: [],
        },
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-21T00:00:04.000Z',
          totalCandidates: 2,
          newCandidateIds: ['cand-success', 'cand-failed'],
          scoredCandidates: ['cand-success'],
          failedCandidates: [{ candidateId: 'cand-failed', error: 'model timeout' }],
        },
      ],
    });

    const result = await exportJobResults('51job', jobKey);

    assert.deepStrictEqual(result.summary, {
      candidateCount: 2,
      successCount: 1,
      failureCount: 1,
    });

    const persisted = await fs.readFile(expectedPath, 'utf8');
    assert.match(persisted, /cand-success/);
    assert.match(persisted, /cand-failed/);
    assert.match(persisted, /model timeout/);
    assert.doesNotMatch(persisted, /cand-older/);
  });

  it('treats an empty latest run as an expected no-new-candidates export', async () => {
    const jobKey = `job-export-empty-latest-run-${Date.now()}`;
    const { expectedPath } = await seedJobData(jobKey, {
      artifacts: [
        {
          candidateId: 'cand-old',
          model: 'claude-test',
          scoredAt: '2026-04-20T00:00:01.000Z',
          status: 'success',
          score: {
            totalScore: 74,
            dimensionScores: {
              education: { score: 74, reason: 'old' },
              language: { score: 74, reason: 'old' },
              experience: { score: 74, reason: 'old' },
              industryMatch: { score: 74, reason: 'old' },
              regionMatch: { score: 74, reason: 'old' },
              responsibilityMatch: { score: 74, reason: 'old' },
            },
            risks: [],
            summary: 'historical success should not be reused',
          },
        },
      ],
      runResults: [
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-20T00:00:02.000Z',
          totalCandidates: 1,
          newCandidateIds: ['cand-old'],
          scoredCandidates: ['cand-old'],
          failedCandidates: [],
        },
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-21T00:00:02.000Z',
          totalCandidates: 0,
          newCandidateIds: [],
          scoredCandidates: [],
          failedCandidates: [],
        },
      ],
    });

    const result = await exportJobResults('51job', jobKey);

    assert.deepStrictEqual(result.summary, {
      candidateCount: 0,
      successCount: 0,
      failureCount: 0,
    });

    const persisted = await fs.readFile(expectedPath, 'utf8');
    assert.match(persisted, /# 东南亚销售经理 评分结果/);
    assert.match(persisted, /- 候选人数: 0/);
    assert.doesNotMatch(persisted, /cand-old/);
  });

  it('fails when latest run candidates have no matching score artifacts', async () => {
    const jobKey = `job-export-current-run-missing-${Date.now()}`;
    await seedJobData(jobKey, {
      artifacts: [
        {
          candidateId: 'cand-old',
          model: 'claude-test',
          scoredAt: '2026-04-20T00:00:01.000Z',
          status: 'success',
          score: {
            totalScore: 74,
            dimensionScores: {
              education: { score: 74, reason: 'old' },
              language: { score: 74, reason: 'old' },
              experience: { score: 74, reason: 'old' },
              industryMatch: { score: 74, reason: 'old' },
              regionMatch: { score: 74, reason: 'old' },
              responsibilityMatch: { score: 74, reason: 'old' },
            },
            risks: [],
            summary: 'historical success should not be reused',
          },
        },
      ],
      runResults: [
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-20T00:00:02.000Z',
          totalCandidates: 1,
          newCandidateIds: ['cand-old'],
          scoredCandidates: ['cand-old'],
          failedCandidates: [],
        },
        {
          jobKey,
          platform: '51job',
          fetchedAt: '2026-04-21T00:00:02.000Z',
          totalCandidates: 1,
          newCandidateIds: ['cand-missing'],
          scoredCandidates: ['cand-missing'],
          failedCandidates: [],
        },
      ],
    });

    await assert.rejects(
      () => exportJobResults('51job', jobKey),
      /No score artifacts found for latest run of job key .*cand-missing/,
    );
  });
  it('fails when no score artifacts exist', async () => {
    const jobKey = `job-export-empty-${Date.now()}`;
    createdJobKeys.push(jobKey);
    await cleanupJob(jobKey);

    const store = new JobStore();
    const jobRecord: JobRecord = {
      jobKey,
      platform: '51job',
      searchKeyword: '华南 销售',
      rawText: 'raw jd',
      normalizedJob: {
        title: '华南销售经理',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-04-21T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', jobRecord);

    await assert.rejects(
      () => exportJobResults('51job', jobKey),
      /No score artifacts found for job key/,
    );
  });
});

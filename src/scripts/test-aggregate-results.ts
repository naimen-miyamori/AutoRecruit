import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CandidateScoreArtifact, JobRecord } from '../types/job.js';
import { aggregateJobResults, renderJobResultsMarkdown } from '../reporting/aggregate-results.js';

describe('aggregateJobResults', () => {
  const jobRecord: JobRecord = {
    jobKey: 'job-export',
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
    createdAt: '2026-04-20T00:00:00.000Z',
  };

  const artifacts: CandidateScoreArtifact[] = [
    {
      candidateId: 'cand-low',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:01.000Z',
      status: 'success',
      score: {
        totalScore: 61,
        dimensionScores: {
          education: { score: 60, reason: 'ok' },
          language: { score: 60, reason: 'ok' },
          experience: { score: 60, reason: 'ok' },
          industryMatch: { score: 60, reason: 'ok' },
          regionMatch: { score: 60, reason: 'ok' },
          responsibilityMatch: { score: 66, reason: 'ok' },
        },
        risks: [],
        summary: '',
      },
    },
    {
      candidateId: 'cand-top',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:00.500Z',
      status: 'failed',
      error: 'Older scoring attempt failed',
    },
    {
      candidateId: 'cand-top',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:02.000Z',
      status: 'success',
      score: {
        totalScore: 92,
        dimensionScores: {
          education: { score: 90, reason: 'ok' },
          language: { score: 90, reason: 'ok' },
          experience: { score: 95, reason: 'ok' },
          industryMatch: { score: 93, reason: 'ok' },
          regionMatch: { score: 92, reason: 'ok' },
          responsibilityMatch: { score: 92, reason: 'ok' },
        },
        risks: ['none'],
        summary: 'top score',
      },
    },
    {
      candidateId: 'cand-failed',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:03.000Z',
      status: 'failed',
      error: 'Scoring timed out',
    },
    {
      candidateId: 'ignored-candidate',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:04.000Z',
      status: 'success',
      score: {
        totalScore: 100,
        dimensionScores: {
          education: { score: 100, reason: 'ok' },
          language: { score: 100, reason: 'ok' },
          experience: { score: 100, reason: 'ok' },
          industryMatch: { score: 100, reason: 'ok' },
          regionMatch: { score: 100, reason: 'ok' },
          responsibilityMatch: { score: 100, reason: 'ok' },
        },
        risks: [],
        summary: 'ignored candidate summary is intentionally long so the overview line is truncated for business scanning',
      },
    },
  ];

  it('aggregates score artifacts into markdown export items with summary counts', () => {
    const generatedAt = '2026-04-21T01:23:45.000Z';

    const result = aggregateJobResults({
      jobRecord,
      scoreArtifacts: artifacts,
      generatedAt,
    });

    assert.equal(result.generatedAt, generatedAt);
    assert.equal(result.jobKey, jobRecord.jobKey);
    assert.equal(result.jobTitle, jobRecord.normalizedJob.title);
    assert.equal(result.searchKeyword, jobRecord.searchKeyword);
    assert.deepStrictEqual(result.summary, {
      candidateCount: 4,
      successCount: 3,
      failureCount: 1,
    });

    assert.deepStrictEqual(result.candidates, [
      {
        candidateId: 'ignored-candidate',
        status: 'success',
        model: 'claude-test',
        scoredAt: '2026-04-21T00:00:04.000Z',
        totalScore: 100,
        dimensionScores: artifacts[4].status === 'success' ? artifacts[4].score.dimensionScores : undefined,
        summary: 'ignored candidate summary is intentionally long so the overview line is truncated for business scanning',
        risks: [],
      },
      {
        candidateId: 'cand-top',
        status: 'success',
        model: 'claude-test',
        scoredAt: '2026-04-21T00:00:02.000Z',
        totalScore: 92,
        dimensionScores: artifacts[2].status === 'success' ? artifacts[2].score.dimensionScores : undefined,
        summary: 'top score',
        risks: ['none'],
      },
      {
        candidateId: 'cand-low',
        status: 'success',
        model: 'claude-test',
        scoredAt: '2026-04-21T00:00:01.000Z',
        totalScore: 61,
        dimensionScores: artifacts[0].status === 'success' ? artifacts[0].score.dimensionScores : undefined,
        summary: '',
        risks: [],
      },
      {
        candidateId: 'cand-failed',
        status: 'failed',
        model: 'claude-test',
        scoredAt: '2026-04-21T00:00:03.000Z',
        error: 'Scoring timed out',
      },
    ]);
  });

  it('renders candidate overview with every successful candidate and full summaries', () => {
    const exportData = aggregateJobResults({
      jobRecord,
      scoreArtifacts: artifacts,
      generatedAt: '2026-04-21T01:23:45.000Z',
    });

    const markdown = renderJobResultsMarkdown(exportData);

    assert.match(markdown, /## 候选人速览/);
    assert.match(markdown, /- 1\. ignored-candidate — 100\n  - 摘要: ignored candidate summary is intentionally long so the overview line is truncated for business scanning/);
    assert.match(markdown, /- 2\. cand-top — 92\n  - 摘要: top score/);
    assert.match(markdown, /- 3\. cand-low — 61\n  - 摘要: 无/);
    assert.equal((markdown.match(/## 候选人速览/)?.length ?? 0), 1);
    assert.ok(markdown.indexOf('ignored candidate summary is intentionally long so the overview line is truncated for business scanning') !== -1);
    assert.doesNotMatch(markdown, /ignored candidate summary is intentionally long…/);
  });

  it('renders markdown with overview, ranking, and failures sections', () => {
    const exportData = aggregateJobResults({
      jobRecord,
      scoreArtifacts: artifacts,
      generatedAt: '2026-04-21T01:23:45.000Z',
    });

    const markdown = renderJobResultsMarkdown(exportData);

    assert.match(markdown, /^# 东南亚销售经理 评分结果/m);
    assert.match(markdown, /- 平台来源: 51job/);
    assert.match(markdown, /- 岗位标识: job-export/);
    assert.match(markdown, /- 候选人数: 4/);
    assert.match(markdown, /## 候选人速览/);
    assert.match(markdown, /- 1\. ignored-candidate — 100\n  - 摘要: ignored candidate summary is intentionally long so the overview line is truncated for business scanning/);
    assert.match(markdown, /- 2\. cand-top — 92\n  - 摘要: top score/);
    assert.match(markdown, /- 3\. cand-low — 61\n  - 摘要: 无/);
    assert.match(markdown, /## 排名结果/);
    assert.match(markdown, /### ignored-candidate — 100/);
    assert.match(markdown, /## 评分失败/);
    assert.match(markdown, /### cand-failed/);
    assert.match(markdown, /- 模型: claude-test/);
    assert.match(markdown, /- 摘要: top score/);
    assert.match(markdown, /- 摘要: 无/);
    assert.match(markdown, /职责匹配: 92 — ok/);
    assert.match(markdown, /## 评分失败/);
    assert.match(markdown, /### cand-failed/);
    assert.match(markdown, /失败原因: Scoring timed out/);
    assert.ok(markdown.indexOf('## 候选人速览') < markdown.indexOf('## 排名结果'));
    assert.doesNotMatch(markdown, /Unscored Candidate/);
    assert.doesNotMatch(markdown, /totalResumes|unscoredCount|regions|pr/);
  });

  it('omits the failures section when no failed candidates exist', () => {
    const exportData = aggregateJobResults({
      jobRecord,
      scoreArtifacts: [artifacts[0], artifacts[4]],
      generatedAt: '2026-04-21T01:23:45.000Z',
    });

    const markdown = renderJobResultsMarkdown(exportData);

    assert.doesNotMatch(markdown, /## 评分失败/);
    assert.doesNotMatch(markdown, /^无。$/m);
  });

  it('renders empty overview and ranking states when no successful candidates exist', () => {
    const exportData = aggregateJobResults({
      jobRecord,
      scoreArtifacts: [artifacts[3]],
      generatedAt: '2026-04-21T01:23:45.000Z',
    });

    const markdown = renderJobResultsMarkdown(exportData);
    const emptyStateMatches = markdown.match(/暂无成功评分结果。/g);

    assert.equal(emptyStateMatches?.length, 2);
    assert.match(markdown, /- 平台来源: 51job/);
    assert.match(markdown, /## 候选人速览/);
    assert.match(markdown, /## 排名结果/);
    assert.match(markdown, /## 评分失败/);
    assert.match(markdown, /### cand-failed/);
  });

  it('uses the current time when generatedAt is omitted', () => {
    const before = Date.now();
    const result = aggregateJobResults({
      jobRecord,
      scoreArtifacts: artifacts.slice(0, 1),
    });
    const after = Date.now();
    const generatedAtMs = Date.parse(result.generatedAt);

    assert.ok(Number.isFinite(generatedAtMs));
    assert.ok(generatedAtMs >= before);
    assert.ok(generatedAtMs <= after);
  });
});

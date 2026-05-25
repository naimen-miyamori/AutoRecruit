import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCandidateScore } from '../scoring/score-schema.js';

describe('parseCandidateScore', () => {
  it('converts valid structured JSON into a candidate score', () => {
    const score = parseCandidateScore(JSON.stringify({
      totalScore: 87,
      dimensionScores: {
        education: { score: 80, reason: '本科且专业相关。' },
        language: { score: 90, reason: '英语可工作沟通。' },
        experience: { score: 88, reason: '有多年相关岗位经验。' },
        industryMatch: { score: 84, reason: '行业背景较接近。' },
        regionMatch: { score: 86, reason: '常驻目标区域。' },
        responsibilityMatch: { score: 94, reason: '职责经历高度重合。' },
      },
      risks: ['Limited direct factory background'],
      summary: 'Strong commercial fit with one industry gap.',
    }));

    assert.deepStrictEqual(score, {
      totalScore: 87,
      dimensionScores: {
        education: { score: 80, reason: '本科且专业相关。' },
        language: { score: 90, reason: '英语可工作沟通。' },
        experience: { score: 88, reason: '有多年相关岗位经验。' },
        industryMatch: { score: 84, reason: '行业背景较接近。' },
        regionMatch: { score: 86, reason: '常驻目标区域。' },
        responsibilityMatch: { score: 94, reason: '职责经历高度重合。' },
      },
      risks: ['Limited direct factory background'],
      summary: 'Strong commercial fit with one industry gap.',
    });
  });

  it('rejects invalid score payloads', () => {
    assert.throws(() => parseCandidateScore(JSON.stringify({
      totalScore: 120,
      dimensionScores: {
        education: { score: 80, reason: 'ok' },
        language: { score: 90, reason: 'ok' },
        experience: { score: 88, reason: 'ok' },
        industryMatch: { score: 84, reason: 'ok' },
        regionMatch: { score: 86, reason: 'ok' },
        responsibilityMatch: { score: 94, reason: 'ok' },
      },
      risks: [],
      summary: 'Out-of-range total score.',
    })));
  });
});

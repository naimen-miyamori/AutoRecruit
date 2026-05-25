import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildScorePrompt } from '../scoring/score-prompt.js';
import type { CandidateResume, NormalizedJob } from '../types/job.js';

describe('buildScorePrompt', () => {
  it('requires concise evidence-only reason style for each dimension', () => {
    const job: NormalizedJob = {
      title: '华南营业经理',
      location: '华南',
      majors: [],
      languageRequirements: [],
      responsibilities: [],
      hardRequirements: [],
      preferredRequirements: [],
      regionPreferences: [],
      industryTags: [],
    };
    const resume: CandidateResume = {
      candidateId: 'cand-1',
      name: '候选人A',
      regions: ['深圳'],
      pr: ['8年经验'],
      workExperiences: [],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: [],
    };

    const prompt = JSON.parse(buildScorePrompt(job, resume)) as {
      requirements: string[];
      outputSchema: {
        dimensionScores: Record<string, { reason: string }>;
      };
    };

    assert.deepStrictEqual(prompt.requirements.slice(0, 8), [
      'Return JSON only. Do not wrap in markdown or add commentary.',
      'Use only evidence present in the job and resume input. Do not infer missing facts.',
      'summary must be a short factual paragraph.',
      'For each dimension score, return an object with integer score (0-100) and concise factual reason.',
      'Each reason must be 1-2 short sentences, evidence-only, and specific to that dimension.',
      'Do not mention the score number, do not use hedging or recommendations, and do not repeat summary/risk wording.',
      'dimensionScores must include education, language, experience, industryMatch, regionMatch, responsibilityMatch.',
      'totalScore must be a 0-100 integer reflecting the overall fit.',
    ]);

    assert.equal(prompt.outputSchema.dimensionScores.education.reason, 'string (1-2 short factual sentences, education evidence only)');
    assert.equal(prompt.outputSchema.dimensionScores.language.reason, 'string (1-2 short factual sentences, language evidence only)');
    assert.equal(prompt.outputSchema.dimensionScores.experience.reason, 'string (1-2 short factual sentences, experience evidence only)');
    assert.equal(prompt.outputSchema.dimensionScores.industryMatch.reason, 'string (1-2 short factual sentences, industry evidence only)');
    assert.equal(prompt.outputSchema.dimensionScores.regionMatch.reason, 'string (1-2 short factual sentences, region evidence only)');
    assert.equal(prompt.outputSchema.dimensionScores.responsibilityMatch.reason, 'string (1-2 short factual sentences, responsibility evidence only)');
  });
});

import { z } from 'zod';
import { config } from '../config.js';
import { completeJsonTextFromOpenAI } from '../llm/openai-client.js';
import { CandidateResume, CandidateScore, NormalizedJob } from '../types/job.js';
import { buildScorePrompt } from './score-prompt.js';
import { candidateScorePayloadSchema, toCandidateScore } from './score-schema.js';

export const completeResumeScoreJsonRef: {
  fn: typeof completeJsonTextFromOpenAI;
} = {
  fn: completeJsonTextFromOpenAI,
};

export function extractCandidateScoreFromTextResponse(rawText: string): CandidateScore {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Scoring model returned empty text content');
  }

  const jsonText = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    : trimmed;

  const payload = candidateScorePayloadSchema.parse(JSON.parse(jsonText));
  return toCandidateScore(payload);
}

export async function scoreResumeAgainstJob(job: NormalizedJob, resume: CandidateResume): Promise<CandidateScore> {
  const prompt = buildScorePrompt(job, resume);
  const responseText = await completeResumeScoreJsonRef.fn({
    featureName: 'scoring',
    modelEnvName: 'SCORING_MODEL',
    completionRoute: config.scoring.completionRoute,
    input: prompt,
    instructions: [
      '你是一个招聘评分器。',
      '只返回 JSON，不要解释，不要 markdown，不要代码块，不要前后缀文本。',
      '必须严格按照给定的输出结构返回。',
      '只使用输入里明确提供的信息，不要补充或猜测。',
    ].join('\n'),
    maxOutputTokens: 900,
    outputSchema: z.toJSONSchema(candidateScorePayloadSchema),
  });

  return extractCandidateScoreFromTextResponse(responseText);
}

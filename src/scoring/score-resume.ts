import { completeJsonTextFromOpenAI } from '../llm/openai-client.js';
import { CandidateResume, CandidateScore, NormalizedJob } from '../types/job.js';
import { buildScorePrompt } from './score-prompt.js';
import { candidateScorePayloadSchema, toCandidateScore } from './score-schema.js';

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
  const responseText = await completeJsonTextFromOpenAI({
    featureName: 'scoring',
    modelEnvName: 'SCORING_MODEL',
    input: prompt,
    instructions: [
      '你是一个招聘评分器。',
      '只返回 JSON，不要解释，不要 markdown，不要代码块，不要前后缀文本。',
      '必须严格按照给定的输出结构返回。',
      '只使用输入里明确提供的信息，不要补充或猜测。',
    ].join('\n'),
    maxOutputTokens: 900,
  });

  return extractCandidateScoreFromTextResponse(responseText);
}

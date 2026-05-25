import { z } from 'zod';
import { CandidateScore } from '../types/job.js';

const scoreDimensionSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string(),
});

const dimensionScoresSchema = z.object({
  education: scoreDimensionSchema,
  language: scoreDimensionSchema,
  experience: scoreDimensionSchema,
  industryMatch: scoreDimensionSchema,
  regionMatch: scoreDimensionSchema,
  responsibilityMatch: scoreDimensionSchema,
});

export const candidateScorePayloadSchema = z.object({
  totalScore: z.number().int().min(0).max(100),
  dimensionScores: dimensionScoresSchema,
  risks: z.array(z.string()),
  summary: z.string(),
});

export type CandidateScorePayload = z.infer<typeof candidateScorePayloadSchema>;

export function toCandidateScore(payload: CandidateScorePayload): CandidateScore {
  return {
    totalScore: payload.totalScore,
    dimensionScores: payload.dimensionScores,
    risks: payload.risks,
    summary: payload.summary,
  };
}

export function parseCandidateScore(rawText: string): CandidateScore {
  const parsedJson = JSON.parse(rawText) as unknown;
  const parsed = candidateScorePayloadSchema.parse(parsedJson);

  return toCandidateScore(parsed);
}

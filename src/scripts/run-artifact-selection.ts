import type { CandidateScoreArtifact, RunResult } from '../types/job.js';

export function getLatestRunResult(runResults: RunResult[], jobKey: string): RunResult {
  const latestRun = runResults.at(-1);

  if (!latestRun) {
    throw new Error(`No run results found for job key ${jobKey}`);
  }

  return latestRun;
}

export function getRunCandidateIds(runResult: RunResult): string[] {
  return [
    ...runResult.scoredCandidates,
    ...runResult.failedCandidates.map((candidate) => candidate.candidateId),
  ];
}

export function filterArtifactsForRun(
  scoreArtifacts: CandidateScoreArtifact[],
  runResult: RunResult,
): CandidateScoreArtifact[] {
  const allowedCandidateIds = new Set(getRunCandidateIds(runResult));

  return scoreArtifacts.filter((artifact) => allowedCandidateIds.has(artifact.candidateId));
}

export function buildMissingArtifactsMessage(runResult: RunResult, emptyCandidateList = '(none)'): string {
  const candidateIds = getRunCandidateIds(runResult);
  const candidateList = candidateIds.length > 0 ? candidateIds.join(', ') : emptyCandidateList;

  return `No score artifacts found for latest run of job key ${runResult.jobKey}; expected candidate IDs: ${candidateList}`;
}

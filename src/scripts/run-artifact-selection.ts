import type { CandidateScoreArtifact, RunResult } from '../types/job.js';

export function getLatestRunResult(runResults: RunResult[], jobKey: string): RunResult {
  const latestRun = runResults.at(-1);

  if (!latestRun) {
    throw new Error(`No run results found for job key ${jobKey}`);
  }

  return latestRun;
}

export function getRunCandidateIds(runResult: RunResult): string[] {
  // This helper describes candidates for which a score artifact is expected,
  // not every card/detail attempt. In v1 `newCandidateIds` is only legacy
  // attempt history and must never be promoted to captured/scored data.
  const processingFailures = runResult.processingFailures
    ?.filter((failure) => failure.stage === 'score')
    .map((failure) => failure.candidateId) ?? [];
  return [...new Set([
    ...runResult.scoredCandidates,
    ...processingFailures,
  ])];
}

/** IDs that the legacy v1 run says were seen/attempted, for filtering only. */
export function getLegacyRunAttemptIds(runResult: RunResult): string[] {
  return runResult.runResultVersion === 2 ? [] : [...new Set(runResult.newCandidateIds ?? [])];
}

export function filterArtifactsForRun(
  scoreArtifacts: CandidateScoreArtifact[],
  runResult: RunResult,
): CandidateScoreArtifact[] {
  const allowedCandidateIds = new Set([
    ...getRunCandidateIds(runResult),
    // v1 has no run-scoped score timestamp/ID. Existing artifacts whose IDs
    // appear in the legacy attempt list are eligible for display, but the
    // caller only asserts artifacts for explicit scored/score-failed IDs.
    ...getLegacyRunAttemptIds(runResult),
  ]);

  return scoreArtifacts.filter((artifact) => allowedCandidateIds.has(artifact.candidateId));
}

export function buildMissingArtifactsMessage(runResult: RunResult, emptyCandidateList = '(none)'): string {
  const candidateIds = getRunCandidateIds(runResult);
  const candidateList = candidateIds.length > 0 ? candidateIds.join(', ') : emptyCandidateList;

  return `No score artifacts found for latest run of job key ${runResult.jobKey}; expected candidate IDs: ${candidateList}`;
}

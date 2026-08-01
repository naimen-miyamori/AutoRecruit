import { aggregateJobResults, renderJobResultsMarkdown } from '../reporting/aggregate-results.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { JobStore } from '../storage/job-store.js';
import type { CandidateScoreArtifact, RunResult } from '../types/job.js';
import { buildMissingArtifactsMessage, filterArtifactsForRun, getLatestRunResult, getRunCandidateIds } from './run-artifact-selection.js';

export interface ExportJobResultsSummary {
  jobKey: string;
  exportPath: string;
  summary: {
    candidateCount: number;
    successCount: number;
    failureCount: number;
  };
  markdown: string;
}

function assertCurrentRunArtifactsFound(
  filteredArtifacts: CandidateScoreArtifact[],
  latestRun: RunResult,
): void {
  const expectedCandidateIds = getRunCandidateIds(latestRun);
  if (expectedCandidateIds.length === 0) {
    return;
  }

  const actualCandidateIds = new Set(filteredArtifacts.map((artifact) => artifact.candidateId));
  const missingCandidateIds = expectedCandidateIds.filter((candidateId) => !actualCandidateIds.has(candidateId));
  if (missingCandidateIds.length === 0) {
    return;
  }

  throw new Error(`${buildMissingArtifactsMessage(latestRun)} Missing artifacts: ${missingCandidateIds.join(', ')}`);
}

async function loadExportInputs(platform: SupportedPlatform, jobKey: string): Promise<{
  store: JobStore;
  jobRecord: Awaited<ReturnType<JobStore['readJobRecord']>>;
  scoreArtifacts: CandidateScoreArtifact[];
}> {
  const store = new JobStore();
  const [jobRecord, scoreArtifacts, runResults] = await Promise.all([
    store.readJobRecord(platform, jobKey),
    store.listStoredScoreArtifacts(platform, jobKey),
    store.listRunResults(platform, jobKey),
  ]);

  if (scoreArtifacts.length === 0 && runResults.length === 0) {
    throw new Error(`No score artifacts found for job key ${jobKey}`);
  }

  const latestRun = getLatestRunResult(runResults, jobKey);
  if (scoreArtifacts.length === 0 && getRunCandidateIds(latestRun).length > 0) {
    throw new Error(`No score artifacts found for job key ${jobKey}`);
  }
  const currentRunArtifacts = filterArtifactsForRun(scoreArtifacts, latestRun);
  assertCurrentRunArtifactsFound(currentRunArtifacts, latestRun);

  return {
    store,
    jobRecord,
    scoreArtifacts: currentRunArtifacts,
  };
}

export async function exportJobResults(platform: SupportedPlatform, jobKey: string): Promise<ExportJobResultsSummary> {
  const { store, jobRecord, scoreArtifacts } = await loadExportInputs(platform, jobKey);

  const exportData = aggregateJobResults({
    jobRecord,
    scoreArtifacts,
  });
  const markdown = renderJobResultsMarkdown(exportData);
  const exportPath = await store.saveJobExport(platform, jobKey, markdown);

  return {
    jobKey,
    exportPath,
    summary: exportData.summary,
    markdown,
  };
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];

  if (!jobKey) {
    throw new Error('Usage: tsx src/scripts/export-job-results.ts <platform> <jobKey>');
  }

  const { markdown } = await exportJobResults(platform, jobKey);
  console.log(markdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

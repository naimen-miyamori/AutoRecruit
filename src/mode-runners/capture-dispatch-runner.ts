import type { SupportedPlatform } from '../platforms/types.js';
import type {
  BatchCliInput,
  BatchRunnableJobInput,
  SingleJobCliInput,
  SinglePlatformCliInput,
} from './types.js';
import type { AllPlatformsRunSummary, BatchJobRunSummary, MainRunSummary } from './run-summary.js';

export interface CaptureDispatchRunnerDependencies {
  loadBatchJobs: (input: BatchCliInput) => Promise<BatchRunnableJobInput[]>;
  listPlatforms: (selection: SingleJobCliInput['platform'], includeBoss: boolean) => SupportedPlatform[];
  preflight: (jobs: Array<SingleJobCliInput | BatchRunnableJobInput>, platforms: SupportedPlatform[]) => Promise<void>;
  warnBossOptIn: () => void;
  buildSinglePlatformInput: (
    input: SingleJobCliInput | BatchRunnableJobInput,
    platform: SupportedPlatform,
  ) => SinglePlatformCliInput;
  runSinglePlatform: (input: SinglePlatformCliInput, options: { printSummary: boolean }) => Promise<MainRunSummary>;
  report: (result: AllPlatformsRunSummary[] | BatchJobRunSummary[]) => void;
}

export async function runBatchCaptureMode(
  input: BatchCliInput,
  dependencies: CaptureDispatchRunnerDependencies,
): Promise<BatchJobRunSummary[]> {
  const jobs = await dependencies.loadBatchJobs(input);
  const platforms = dependencies.listPlatforms(input.platform, input.includeBoss);
  await dependencies.preflight(jobs, platforms);
  if (input.includeBoss) dependencies.warnBossOptIn();
  const summaries: BatchJobRunSummary[] = [];

  for (const job of jobs) {
    for (const platform of platforms) {
      summaries.push({
        keyword: job.searchKeyword,
        platform,
        summary: await dependencies.runSinglePlatform(
          dependencies.buildSinglePlatformInput(job, platform),
          { printSummary: false },
        ),
      });
    }
  }

  dependencies.report(summaries);
  return summaries;
}

export async function runAllPlatformsCaptureMode(
  input: SingleJobCliInput,
  dependencies: CaptureDispatchRunnerDependencies,
): Promise<AllPlatformsRunSummary[]> {
  const platforms = dependencies.listPlatforms(input.platform, input.includeBoss);
  await dependencies.preflight([input], platforms);
  if (input.includeBoss) dependencies.warnBossOptIn();
  const summaries: AllPlatformsRunSummary[] = [];

  for (const platform of platforms) {
    summaries.push({
      platform,
      summary: await dependencies.runSinglePlatform(
        dependencies.buildSinglePlatformInput(input, platform),
        { printSummary: false },
      ),
    });
  }

  dependencies.report(summaries);
  return summaries;
}

import type { TalentMappingPlan } from '../types/talent-mapping.js';
import type { TalentMappingRunSummary } from '../types/talent-mapping.js';
import type { TalentMappingCliInput } from './types.js';

export interface TalentMappingRunnerDependencies {
  loadPlan: (
    filePath: string,
    overrides: { platformSelection: TalentMappingCliInput['platform'] },
  ) => Promise<TalentMappingPlan>;
  runWorkflow: (input: {
    plan: TalentMappingPlan;
    planFilePath: string;
    platformSelection: TalentMappingCliInput['platform'];
    stage: TalentMappingCliInput['stage'];
    confirmedDetailOpen: boolean;
    sourceScanRunId?: string;
  }) => Promise<TalentMappingRunSummary>;
  report: (summary: TalentMappingRunSummary) => void;
}

export async function runTalentMappingMode(
  input: TalentMappingCliInput,
  dependencies: TalentMappingRunnerDependencies,
): Promise<TalentMappingRunSummary> {
  const plan = await dependencies.loadPlan(input.filePath, {
    platformSelection: input.platform,
  });
  const summary = await dependencies.runWorkflow({
    plan,
    planFilePath: input.filePath,
    platformSelection: input.platform,
    stage: input.stage,
    confirmedDetailOpen: input.confirmedDetailOpen,
    sourceScanRunId: input.sourceScanRunId,
  });
  dependencies.report(summary);
  return summary;
}

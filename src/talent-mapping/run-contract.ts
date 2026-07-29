import { createHash } from 'node:crypto';
import {
  TALENT_MAPPING_CORE_PLATFORMS,
  type MappingRunContract,
  type MappingRunScopeFingerprint,
  type TalentMappingCorePlatform,
  type TalentMappingPlan,
  type TalentMappingPlatformSelection,
} from '../types/talent-mapping.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

export function stableMappingHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function selectedPlatforms(selection: TalentMappingPlatformSelection): TalentMappingCorePlatform[] {
  return selection === 'all' ? [...TALENT_MAPPING_CORE_PLATFORMS] : [selection];
}

export function buildMappingRunScopeFingerprint(input: {
  plan: TalentMappingPlan;
  platformSelection: TalentMappingPlatformSelection;
}): MappingRunScopeFingerprint {
  const platforms = selectedPlatforms(input.platformSelection);
  const slices = input.plan.slices.flatMap((slice) => platforms.flatMap((platform) => {
    const platformPlan = slice.platformPlans[platform];
    if (!platformPlan || platformPlan.disabled) return [];
    return [{
      sliceId: slice.sliceId,
      platform,
      searchPlanHash: stableMappingHash({
        searchSource: platformPlan.searchSource,
        searchPlan: platformPlan.searchPlan,
      }),
    }];
  }));
  return {
    platforms,
    slices,
    coverage: { ...input.plan.coverage },
  };
}

export function buildMappingRunContract(input: {
  plan: TalentMappingPlan;
  runId: string;
  platformSelection: TalentMappingPlatformSelection;
  capturedAt: string;
}): MappingRunContract {
  const scopeFingerprint = buildMappingRunScopeFingerprint(input);
  const scanContract = {
    version: 1,
    mappingKey: input.plan.mappingKey,
    objective: input.plan.objective,
    taxonomy: input.plan.taxonomy,
    slices: input.plan.slices,
    coverage: input.plan.coverage,
  };
  return {
    version: 1,
    mappingKey: input.plan.mappingKey,
    runId: input.runId,
    capturedAt: input.capturedAt,
    plan: JSON.parse(JSON.stringify(input.plan)) as TalentMappingPlan,
    planHash: stableMappingHash(input.plan),
    scanContractHash: stableMappingHash(scanContract),
    scopeFingerprint,
  };
}

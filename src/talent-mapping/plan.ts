import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadSearchConditionPlanFile } from '../search/search-subscription.js';
import {
  TALENT_MAPPING_CORE_PLATFORMS,
  type MappingPlatformPlan,
  type MappingSlice,
  type TalentMappingCorePlatform,
  type TalentMappingPlan,
  type TalentMappingPlatformSelection,
} from '../types/talent-mapping.js';

const nonEmptyString = z.string().trim().min(1);
const stableKey = nonEmptyString.refine(
  (value) => value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0'),
  'must be a stable path-safe key without slashes or traversal segments',
);
const positiveInteger = z.number().int().positive();

const enabledPlatformPlanSchema = z.object({
  disabled: z.literal(false).optional(),
  searchSource: z.enum(['saved', 'direct']),
  searchPlanFile: nonEmptyString,
}).strict();

const disabledPlatformPlanSchema = z.object({
  disabled: z.literal(true),
  reason: nonEmptyString,
}).strict();

const platformPlanSchema = z.union([
  enabledPlatformPlanSchema,
  disabledPlatformPlanSchema,
]);

const sliceSchema = z.object({
  sliceId: stableKey,
  label: nonEmptyString,
  platformPlans: z.object({
    '51job': platformPlanSchema.optional(),
    liepin: platformPlanSchema.optional(),
    zhilian: platformPlanSchema.optional(),
  }).strict(),
}).strict();

const selectionSchema = z.object({
  targetCompanyTiers: z.array(nonEmptyString).optional(),
  roleKeys: z.array(stableKey).optional(),
  levels: z.array(nonEmptyString).optional(),
  locations: z.array(nonEmptyString).optional(),
  samplePerMatrixCell: positiveInteger,
}).strict();

const rawPlanSchema = z.object({
  version: z.literal(1),
  mappingKey: stableKey,
  name: nonEmptyString,
  objective: z.object({
    roleFamilies: z.array(nonEmptyString),
    locations: z.array(nonEmptyString),
    notes: nonEmptyString.optional(),
  }).strict(),
  taxonomy: z.object({
    targetCompanies: z.array(z.object({
      companyKey: stableKey,
      displayName: nonEmptyString,
      aliases: z.array(nonEmptyString),
      tier: nonEmptyString,
    }).strict()),
    roleFamilies: z.array(z.object({
      roleKey: stableKey,
      displayName: nonEmptyString,
      titleAliases: z.array(nonEmptyString).min(1),
    }).strict()),
    levels: z.array(nonEmptyString),
  }).strict(),
  slices: z.array(sliceSchema).min(1),
  coverage: z.object({
    maxBatchesPerSlice: positiveInteger,
    maxCandidatesPerSlice: positiveInteger,
    sliceTimeoutMs: positiveInteger,
  }).strict(),
  enrichment: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('card-only'),
    }).strict(),
    z.object({
      mode: z.literal('targeted-detail'),
      maxProfilesPerSlice: positiveInteger,
      maxProfilesTotal: positiveInteger,
      selection: selectionSchema,
    }).strict(),
    z.object({
      mode: z.literal('full-detail'),
      maxProfilesPerSlice: positiveInteger,
      maxProfilesTotal: positiveInteger,
      selection: selectionSchema,
    }).strict(),
  ]),
}).strict();

type RawTalentMappingPlan = z.infer<typeof rawPlanSchema>;

export interface LoadTalentMappingPlanOptions {
  platformSelection: TalentMappingPlatformSelection;
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
    .join('; ');
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} must be unique; duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

function validateTaxonomyReferences(plan: RawTalentMappingPlan): void {
  assertUnique(plan.slices.map((slice) => slice.sliceId), 'Talent Mapping sliceId');
  assertUnique(plan.taxonomy.targetCompanies.map((company) => company.companyKey), 'Talent Mapping companyKey');
  assertUnique(plan.taxonomy.roleFamilies.map((role) => role.roleKey), 'Talent Mapping roleKey');

  const companyTiers = new Set(plan.taxonomy.targetCompanies.map((company) => company.tier));
  const roleKeys = new Set(plan.taxonomy.roleFamilies.map((role) => role.roleKey));
  const levels = new Set(plan.taxonomy.levels);
  const locations = new Set(plan.objective.locations);

  if (plan.enrichment.mode === 'card-only') {
    return;
  }

  for (const tier of plan.enrichment.selection.targetCompanyTiers ?? []) {
    if (!companyTiers.has(tier)) {
      throw new Error(`Talent Mapping enrichment references unknown company tier: ${tier}`);
    }
  }
  for (const roleKey of plan.enrichment.selection.roleKeys ?? []) {
    if (!roleKeys.has(roleKey)) {
      throw new Error(`Talent Mapping enrichment references unknown roleKey: ${roleKey}`);
    }
  }
  for (const level of plan.enrichment.selection.levels ?? []) {
    if (!levels.has(level)) {
      throw new Error(`Talent Mapping enrichment references unknown level: ${level}`);
    }
  }
  for (const location of plan.enrichment.selection.locations ?? []) {
    if (!locations.has(location)) {
      throw new Error(`Talent Mapping enrichment references location outside objective.locations: ${location}`);
    }
  }
}

function selectedPlatforms(selection: TalentMappingPlatformSelection): TalentMappingCorePlatform[] {
  return selection === 'all' ? [...TALENT_MAPPING_CORE_PLATFORMS] : [selection];
}

function validatePlatformCoverage(
  plan: RawTalentMappingPlan,
  selection: TalentMappingPlatformSelection,
): void {
  for (const slice of plan.slices) {
    for (const platform of selectedPlatforms(selection)) {
      const platformPlan = slice.platformPlans[platform];
      if (!platformPlan) {
        throw new Error(
          `Talent Mapping slice ${slice.sliceId} must provide a ${platform} platform plan`
          + (selection === 'all' ? ' or explicitly disable it with a reason' : ''),
        );
      }
      if (selection !== 'all' && platformPlan.disabled) {
        throw new Error(`Talent Mapping slice ${slice.sliceId} explicitly disables selected platform ${platform}: ${platformPlan.reason}`);
      }
    }
  }
}

async function compilePlatformPlan(
  rawPlan: z.infer<typeof platformPlanSchema>,
  platform: TalentMappingCorePlatform,
  mappingFilePath: string,
): Promise<MappingPlatformPlan> {
  if (rawPlan.disabled) {
    return {
      disabled: true,
      reason: rawPlan.reason,
    };
  }

  const searchPlanFile = path.resolve(path.dirname(mappingFilePath), rawPlan.searchPlanFile);
  const searchPlan = await loadSearchConditionPlanFile(searchPlanFile, { platform });
  return {
    searchSource: rawPlan.searchSource,
    searchPlanFile,
    searchPlan,
  };
}

async function compileSlice(slice: RawTalentMappingPlan['slices'][number], mappingFilePath: string): Promise<MappingSlice> {
  const entries = await Promise.all(
    TALENT_MAPPING_CORE_PLATFORMS.map(async (platform) => {
      const rawPlatformPlan = slice.platformPlans[platform];
      return rawPlatformPlan
        ? [platform, await compilePlatformPlan(rawPlatformPlan, platform, mappingFilePath)] as const
        : undefined;
    }),
  );

  return {
    sliceId: slice.sliceId,
    label: slice.label,
    platformPlans: Object.fromEntries(entries.filter((entry) => entry !== undefined)),
  };
}

export async function loadTalentMappingPlanFile(
  filePath: string,
  options: LoadTalentMappingPlanOptions,
): Promise<TalentMappingPlan> {
  const resolvedFilePath = path.resolve(filePath);
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(resolvedFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in --talent-mapping-file ${filePath}: ${error.message}`);
    }
    throw error;
  }

  const result = rawPlanSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Invalid Talent Mapping plan: ${describeZodError(result.error)}`);
  }

  validateTaxonomyReferences(result.data);
  validatePlatformCoverage(result.data, options.platformSelection);

  return {
    ...result.data,
    slices: await Promise.all(result.data.slices.map((slice) => compileSlice(slice, resolvedFilePath))),
  };
}

export function isMappingPlatformPlanEnabled(
  plan: MappingPlatformPlan | undefined,
): plan is Exclude<MappingPlatformPlan, { disabled: true }> {
  return Boolean(plan) && plan?.disabled !== true;
}

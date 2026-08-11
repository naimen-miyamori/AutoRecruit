import { z } from 'zod';
import {
  cliSearchModeIds,
  compileSearchOperationMode,
  getOperationModeDefinition,
  listOperationModeDefinitions,
  listOperationModeDefinitionsForPicker,
  operationModeIds,
  operationModePickerTargetIds,
  operationModeTaskKindIds,
  type OperationModeSurface,
} from '../operation-modes.js';

export const supportedPlatformSchema = z.enum(['51job', 'liepin', 'zhilian', 'boss']);
export const platformSelectionSchema = z.union([supportedPlatformSchema, z.literal('all')]);

export const operationModeIdSchema = z.enum(operationModeIds);
export const operationModeSurfaceSchema = z.enum(['assistant', 'manual', 'schedule', 'cli']);
export const operationModePickerTargetSchema = z.enum(operationModePickerTargetIds as ['manual-search-create', 'schedule-search-create']);

export const taskStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const taskKindSchema = z.enum([
  'resume-capture',
  'batch',
  'search-subscription',
  'boss-auto-chat',
  'boss-talent-search',
  'boss-greet',
  'boss-chat-operation',
  'boss-job-sync',
  'login-refresh',
  'rag-ops',
  'talent-mapping',
  'talent-mapping-classification',
]);
export const operationModeTaskKindSchema = z.enum(operationModeTaskKindIds);

const operationModePickerOrdersSchema = z.object({
  'manual-search-create': z.number().int().nonnegative().optional(),
  'schedule-search-create': z.number().int().nonnegative().optional(),
}).strict();

export const operationModePickerGroupSchema = z.object({
  groupId: z.string().min(1),
  label: z.string().min(1),
  orders: operationModePickerOrdersSchema,
});

export const operationModeCatalogItemSchema = z.object({
  modeId: operationModeIdSchema,
  label: z.string().min(1),
  taskKind: operationModeTaskKindSchema,
  searchSource: z.enum(['saved', 'direct', 'reuse-job-settings']).optional(),
  effectSummary: z.string().min(1),
  declaredEffects: z.string().min(1),
  surfaces: z.array(operationModeSurfaceSchema),
  pickerTargets: z.array(operationModePickerTargetSchema),
  pickerGroupId: z.string().min(1).optional(),
  pickerOrder: z.number().int().nonnegative().optional(),
});
export const operationModeCatalogSchema = z.object({
  groups: z.array(operationModePickerGroupSchema),
  modes: z.array(operationModeCatalogItemSchema),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const platformRuntimeSafeStatusSchema = z.enum([
  'absent',
  'starting',
  'login_required',
  'published',
  'busy',
  'unreachable',
  'invalid',
  'degraded',
  'recovery_required',
]);

export const platformRuntimeIssueCodeSchema = z.enum([
  'browser-runtime-missing',
  'browser-runtime-manifest-invalid',
  'browser-runtime-unreachable',
  'browser-runtime-generation-mismatch',
  'browser-runtime-work-page-missing',
  'browser-runtime-work-page-ambiguous',
  'browser-runtime-auth-required',
  'browser-runtime-busy',
  'browser-runtime-lease-lost',
  'browser-runtime-recovery-required',
  'browser-runtime-config-conflict',
  'browser-runtime-handoff-uncertain',
  'browser-runtime-unpublished-endpoint',
  'browser-runtime-degraded',
]);

export const platformRuntimeSafeViewSchema = z.object({
  platform: supportedPlatformSchema,
  status: platformRuntimeSafeStatusSchema,
  issueCodes: z.array(platformRuntimeIssueCodeSchema),
  generationFingerprint: z.string().regex(/^[0-9a-f]{8}$/i).optional(),
  revision: z.number().int().positive().optional(),
  authenticatedAt: z.string().datetime().optional(),
  publishedAt: z.string().datetime().optional(),
  endpointReachable: z.boolean().optional(),
  occupiedBy: z.object({
    operationId: z.string().min(1).max(256),
    operationKind: z.string().min(1).max(128),
    acquiredAt: z.string().datetime(),
  }).strict().optional(),
}).strict();

export const platformRuntimeListResponseSchema = z.object({
  runtimes: z.array(platformRuntimeSafeViewSchema),
}).strict();

export const artifactDescriptorSchema = z.object({
  artifactId: z.string().min(1),
  label: z.string().min(1),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>;
export type OperationModeCatalog = z.infer<typeof operationModeCatalogSchema>;
export type OperationModeCatalogItem = z.infer<typeof operationModeCatalogItemSchema>;
export type PlatformRuntimeSafeViewResponse = z.infer<typeof platformRuntimeSafeViewSchema>;

export function parsePlatformRuntimeListResponse(value: unknown): {
  runtimes: PlatformRuntimeSafeViewResponse[];
} {
  try {
    const parsed = platformRuntimeListResponseSchema.parse(value);
    const expected = new Set(['51job', 'liepin', 'zhilian', 'boss']);
    if (parsed.runtimes.length !== expected.size
      || new Set(parsed.runtimes.map((runtime) => runtime.platform)).size !== expected.size
      || parsed.runtimes.some((runtime) => !expected.has(runtime.platform))) {
      throw new Error('runtime platform set is incomplete or duplicated');
    }
    return parsed;
  } catch (error) {
    throw new Error(`platform-browser-runtime-shape: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertExactIdSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== actual.length || actualSet.size !== expectedSet.size || actual.some((id) => !expectedSet.has(id))) {
    throw new Error(`operation-mode-catalog-integrity: ${label}`);
  }
}

export function parseOperationModeCatalogResponse(
  value: unknown,
  context: { surface?: OperationModeSurface } = {},
): OperationModeCatalog {
  let catalog: OperationModeCatalog;
  try {
    catalog = operationModeCatalogSchema.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`operation-mode-catalog-shape: ${message}`);
  }

  const modeIds = catalog.modes.map((mode) => mode.modeId);
  const groupIds = catalog.groups.map((group) => group.groupId);
  if (new Set(modeIds).size !== modeIds.length) throw new Error('operation-mode-catalog-integrity: duplicate modeId');
  if (new Set(groupIds).size !== groupIds.length) throw new Error('operation-mode-catalog-integrity: duplicate groupId');
  assertExactIdSet(modeIds, listOperationModeDefinitions(context.surface).map((definition) => definition.modeId), 'mode set');

  for (const mode of catalog.modes) {
    const definition = getOperationModeDefinition(mode.modeId);
    assertExactIdSet(mode.surfaces, definition.surfaces, `surface declarations ${mode.modeId}`);
    assertExactIdSet(mode.pickerTargets, definition.pickerTargets, `picker target declarations ${mode.modeId}`);
    if (context.surface && !mode.surfaces.includes(context.surface)) {
      throw new Error(`operation-mode-catalog-integrity: surface mismatch ${mode.modeId}`);
    }
    if (mode.effectSummary !== mode.declaredEffects) {
      throw new Error(`operation-mode-catalog-integrity: effect mismatch ${mode.modeId}`);
    }
    if (mode.taskKind !== definition.taskKind || mode.searchSource !== definition.searchSource) {
      throw new Error(`operation-mode-catalog-integrity: operation mapping mismatch ${mode.modeId}`);
    }
    if (cliSearchModeIds.includes(mode.modeId as (typeof cliSearchModeIds)[number])) {
      const compiled = compileSearchOperationMode(mode.modeId as (typeof cliSearchModeIds)[number]);
      const searchSourceMatchesCompiler = mode.modeId === 'capture.reuse-job-settings'
        ? mode.searchSource === 'reuse-job-settings'
        : mode.searchSource === compiled.searchSource;
      if (mode.taskKind !== compiled.taskKind || !searchSourceMatchesCompiler) {
        throw new Error(`operation-mode-catalog-integrity: search compiler mismatch ${mode.modeId}`);
      }
    }
  }

  const target = context.surface === 'manual'
    ? 'manual-search-create'
    : context.surface === 'schedule'
      ? 'schedule-search-create'
      : undefined;
  if (!target) {
    if (catalog.groups.length !== 0) throw new Error('operation-mode-catalog-integrity: unexpected picker groups');
    return catalog;
  }

  const expectedPickerIds = listOperationModeDefinitionsForPicker(target).map((definition) => definition.modeId);
  const actualPickerIds = catalog.modes
    .filter((mode) => mode.pickerTargets.includes(target))
    .map((mode) => mode.modeId);
  assertExactIdSet(actualPickerIds, expectedPickerIds, `${target} mode set`);

  const groupOrders = new Set<string>();
  for (const group of catalog.groups) {
    const order = group.orders[target];
    if (order === undefined) continue;
    const key = `${target}:${order}`;
    if (groupOrders.has(key)) throw new Error(`operation-mode-catalog-integrity: duplicate group order ${key}`);
    groupOrders.add(key);
  }

  const pickerKeys = new Set<string>();
  for (const mode of catalog.modes.filter((candidate) => candidate.pickerTargets.includes(target))) {
    if (!mode.pickerGroupId || mode.pickerOrder === undefined) {
      throw new Error(`operation-mode-catalog-integrity: missing picker reference ${mode.modeId}`);
    }
    const group = catalog.groups.find((candidate) => candidate.groupId === mode.pickerGroupId);
    if (!group || group.orders[target] === undefined) {
      throw new Error(`operation-mode-catalog-integrity: invalid picker group ${mode.modeId}`);
    }
    const key = `${target}:${mode.pickerGroupId}:${mode.pickerOrder}`;
    if (pickerKeys.has(key)) throw new Error(`operation-mode-catalog-integrity: duplicate picker tuple ${key}`);
    pickerKeys.add(key);
  }

  return catalog;
}

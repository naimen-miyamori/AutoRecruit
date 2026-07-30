import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { config } from '../config.js';
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '../platforms/types.js';
import {
  validateApplicationFilterInput,
  type ApplicationFilterOptions,
  type ValidateApplicationFilterInputError,
} from './filter-application-options.js';
import { buildApplicationFilterConditions } from './search-subscription.js';
import { SearchConditionSetStore, type SearchConditionSetStoreOptions } from './search-condition-set-store.js';
import {
  SEARCH_CONDITION_SET_SCHEMA_VERSION,
  SearchConditionSetArchivedError,
  SearchConditionSetCatalogDriftError,
  SearchConditionSetConflictError,
  SearchConditionSetNotFoundError,
  SearchConditionSetValidationError,
  type ArchiveSearchConditionSetInput,
  type CloneSearchConditionSetInput,
  type CreateSearchConditionSetInput,
  type ResolvedSearchConditionSet,
  type ReviseSearchConditionSetInput,
  type SearchConditionSetCatalogEvidence,
  type SearchConditionSetFieldError,
  type SearchConditionSetListOptions,
  type SearchConditionSetReference,
  type SearchConditionSetRevision,
  type SearchConditionSetStatus,
  type SearchConditionSetSummary,
} from './search-condition-set-types.js';

export { SearchConditionSetStore } from './search-condition-set-store.js';
export type { SearchConditionSetStoreOptions } from './search-condition-set-store.js';
export {
  SEARCH_CONDITION_SET_SCHEMA_VERSION,
  SearchConditionSetArchivedError,
  SearchConditionSetCatalogDriftError,
  SearchConditionSetConflictError,
  SearchConditionSetError,
  SearchConditionSetNotFoundError,
  SearchConditionSetStorageError,
  SearchConditionSetValidationError,
} from './search-condition-set-types.js';
export type {
  ArchiveSearchConditionSetInput,
  CloneSearchConditionSetInput,
  CreateSearchConditionSetInput,
  ResolvedSearchConditionSet,
  ReviseSearchConditionSetInput,
  SearchConditionSetCatalogEvidence,
  SearchConditionSetFieldError,
  SearchConditionSetListOptions,
  SearchConditionSetReference,
  SearchConditionSetRevision,
  SearchConditionSetStatus,
  SearchConditionSetSummary,
} from './search-condition-set-types.js';

export interface SearchConditionSetCompatibility {
  status: 'compatible' | 'drifted' | 'incompatible' | 'unknown';
  message?: string;
  selectedFieldsFingerprint?: string;
  checkedAt: string;
  errors?: SearchConditionSetFieldError[];
}

export interface SearchConditionSetDetail {
  conditionSet: SearchConditionSetRevision;
  revisions: SearchConditionSetRevision[];
  compatibility: SearchConditionSetCompatibility;
}

export interface SearchConditionSetServiceOptions extends SearchConditionSetStoreOptions {
  store?: SearchConditionSetStore;
  now?: () => Date;
  applicationFilterOptionsPath?: (platform: SupportedPlatform) => string;
}

function assertSupportedPlatform(value: SupportedPlatform): void {
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(value)) {
    throw new SearchConditionSetValidationError('platform is not supported', [{
      fieldId: 'platform',
      code: 'unsupported_platform',
      message: `Unsupported platform: ${value}`,
    }]);
  }
}

function normalizeText(value: string, fieldId: string, required = false): string | undefined {
  if (typeof value !== 'string') {
    throw new SearchConditionSetValidationError(`${fieldId} must be a string`, [{
      fieldId,
      code: 'invalid_type',
      message: `${fieldId} must be a string.`,
    }]);
  }
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (required && !normalized) {
    throw new SearchConditionSetValidationError(`${fieldId} is required`, [{
      fieldId,
      code: 'required',
      message: `${fieldId} must be non-empty.`,
    }]);
  }
  return normalized || undefined;
}

function normalizeName(value: string): string {
  const name = normalizeText(value, 'name', true)!;
  if (name.length > 120) {
    throw new SearchConditionSetValidationError('name is too long', [{
      fieldId: 'name',
      code: 'too_long',
      message: 'name must contain at most 120 characters.',
    }]);
  }
  return name;
}

function normalizedNameKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'selected' && key !== 'capturedAt' && key !== 'keyword')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function cloneInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function normalizeApplicationFilterInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SearchConditionSetValidationError('applicationFilterInput must be an object', [{
      fieldId: 'applicationFilterInput',
      code: 'invalid_type',
      message: 'applicationFilterInput must be a JSON object.',
    }]);
  }
  return cloneInput(value as Record<string, unknown>);
}

function defaultApplicationFilterOptionsPath(dataDir: string, platform: SupportedPlatform): string {
  return path.join(dataDir, platform, 'filter-catalog', 'application-filter-options.latest.json');
}

function toFieldErrors(errors: ValidateApplicationFilterInputError[], source?: 'catalog_drift'): SearchConditionSetFieldError[] {
  return errors.map((error) => ({ ...error, ...(source ? { source } : {}) }));
}

function fieldDefinitionsForInput(
  options: ApplicationFilterOptions,
  applicationFilterInput: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(applicationFilterInput)
    .sort()
    .map((fieldId) => [fieldId, options.fieldsById[fieldId]]));
}

function fingerprintSelectedFields(
  options: ApplicationFilterOptions,
  applicationFilterInput: Record<string, unknown>,
): string {
  const selected = fieldDefinitionsForInput(options, applicationFilterInput);
  return createHash('sha256').update(stableJson(selected)).digest('hex');
}

function sameConditions(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(stableJson(left)), JSON.parse(stableJson(right)));
}

export class SearchConditionSetService {
  readonly store: SearchConditionSetStore;
  private readonly now: () => Date;
  private readonly getApplicationFilterOptionsPath: (platform: SupportedPlatform) => string;

  constructor(options: SearchConditionSetServiceOptions = {}) {
    this.store = options.store ?? new SearchConditionSetStore({ dataDir: options.dataDir ?? config.dataDir });
    this.now = options.now ?? (() => new Date());
    this.getApplicationFilterOptionsPath = options.applicationFilterOptionsPath
      ?? ((platform) => defaultApplicationFilterOptionsPath(this.store.dataDir, platform));
  }

  private async readOptions(platform: SupportedPlatform): Promise<ApplicationFilterOptions> {
    const filePath = this.getApplicationFilterOptionsPath(platform);
    let options: ApplicationFilterOptions;
    try {
      options = JSON.parse(await readFile(filePath, 'utf8')) as ApplicationFilterOptions;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SearchConditionSetValidationError('Current application filter options contain invalid JSON.', [{
          fieldId: 'catalog',
          code: 'invalid_catalog_json',
          message: error.message,
        }]);
      }
      throw error;
    }
    if (options.platform !== platform) {
      throw new SearchConditionSetValidationError('Application filter options platform mismatch.', [{
        fieldId: 'platform',
        code: 'catalog_platform_mismatch',
        message: `Expected ${platform}, got ${options.platform}.`,
      }]);
    }
    return options;
  }

  private async compile(
    platform: SupportedPlatform,
    applicationFilterInput: Record<string, unknown>,
  ): Promise<{ conditions: SearchConditionSetRevision['compiledConditions']; catalogEvidence: SearchConditionSetCatalogEvidence }> {
    const options = await this.readOptions(platform);
    const validation = validateApplicationFilterInput(options, applicationFilterInput);
    if (!validation.ok) {
      throw new SearchConditionSetValidationError('Invalid applicationFilterInput.', toFieldErrors(validation.errors));
    }
    const conditions = await buildApplicationFilterConditions(platform, applicationFilterInput, {
      applicationFilterOptionsPath: this.getApplicationFilterOptionsPath(platform),
    });
    return {
      conditions,
      catalogEvidence: {
        capturedAt: options.capturedAt,
        selectedFieldsFingerprint: fingerprintSelectedFields(options, applicationFilterInput),
      },
    };
  }

  private async assertUniqueName(platform: SupportedPlatform, name: string, exceptConditionSetId?: string): Promise<void> {
    const key = normalizedNameKey(name);
    const duplicate = (await this.store.list({ platform }))
      .find((item) => item.conditionSetId !== exceptConditionSetId && normalizedNameKey(item.name) === key);
    if (duplicate) {
      throw new SearchConditionSetValidationError('A condition set with this name already exists for the platform.', [{
        fieldId: 'name',
        code: 'duplicate_name',
        message: `Name is already used by ${duplicate.conditionSetId}.`,
      }]);
    }
  }

  private assertNotEmpty(defaultKeyword: string | undefined, applicationFilterInput: Record<string, unknown>): void {
    if (!defaultKeyword && Object.keys(applicationFilterInput).length === 0) {
      throw new SearchConditionSetValidationError('A condition set needs a default keyword or at least one filter field.', [{
        fieldId: 'applicationFilterInput',
        code: 'empty_condition_set',
        message: 'Provide defaultKeyword or at least one application filter field.',
      }]);
    }
  }

  private async buildRevision(input: {
    conditionSetId: string;
    platform: SupportedPlatform;
    revision: number;
    name: string;
    description?: string;
    defaultKeyword?: string;
    applicationFilterInput: Record<string, unknown>;
    status: SearchConditionSetStatus;
    createdAt: string;
  }): Promise<SearchConditionSetRevision> {
    const { conditions, catalogEvidence } = await this.compile(input.platform, input.applicationFilterInput);
    return {
      schemaVersion: SEARCH_CONDITION_SET_SCHEMA_VERSION,
      conditionSetId: input.conditionSetId,
      platform: input.platform,
      revision: input.revision,
      name: input.name,
      description: input.description,
      defaultKeyword: input.defaultKeyword,
      applicationFilterInput: cloneInput(input.applicationFilterInput),
      compiledConditions: conditions,
      catalogEvidence,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: this.now().toISOString(),
    };
  }

  async list(options: SearchConditionSetListOptions = {}): Promise<SearchConditionSetSummary[]> {
    return this.store.list(options);
  }

  async create(input: CreateSearchConditionSetInput): Promise<SearchConditionSetRevision> {
    assertSupportedPlatform(input.platform);
    const name = normalizeName(input.name);
    const description = input.description === undefined ? undefined : normalizeText(input.description, 'description');
    const defaultKeyword = input.defaultKeyword === undefined ? undefined : normalizeText(input.defaultKeyword, 'defaultKeyword');
    const applicationFilterInput = normalizeApplicationFilterInput(input.applicationFilterInput);
    this.assertNotEmpty(defaultKeyword, applicationFilterInput);
    await this.assertUniqueName(input.platform, name);
    const timestamp = this.now().toISOString();
    const revision = await this.buildRevision({
      conditionSetId: `scs-${randomUUID()}`,
      platform: input.platform,
      revision: 1,
      name,
      description,
      defaultKeyword,
      applicationFilterInput,
      status: 'active',
      createdAt: timestamp,
    });
    await this.store.create(revision);
    return revision;
  }

  async get(reference: Pick<SearchConditionSetReference, 'platform' | 'conditionSetId'>): Promise<SearchConditionSetDetail> {
    const conditionSet = await this.store.getCurrent(reference.platform, reference.conditionSetId);
    const revisions = await this.store.listRevisions(reference.platform, reference.conditionSetId);
    return {
      conditionSet,
      revisions,
      compatibility: await this.checkCompatibility(conditionSet),
    };
  }

  async getById(conditionSetId: string, platform?: SupportedPlatform): Promise<SearchConditionSetDetail> {
    if (platform) {
      return this.get({ conditionSetId, platform });
    }
    const matches = (await this.store.list()).filter((summary) => summary.conditionSetId === conditionSetId);
    if (matches.length !== 1) {
      throw new SearchConditionSetNotFoundError({ conditionSetId, platform: '51job' });
    }
    return this.get(matches[0]);
  }

  async revise(
    reference: Pick<SearchConditionSetReference, 'platform' | 'conditionSetId'>,
    input: ReviseSearchConditionSetInput,
  ): Promise<SearchConditionSetRevision> {
    const current = await this.store.getCurrent(reference.platform, reference.conditionSetId);
    if (current.revision !== input.expectedRevision) {
      throw new SearchConditionSetConflictError({
        ...reference,
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
      });
    }
    if (current.status === 'archived') {
      throw new SearchConditionSetArchivedError({ ...reference, revision: current.revision });
    }
    const name = input.name === undefined ? current.name : normalizeName(input.name);
    const description = input.description === undefined
      ? current.description
      : input.description === null ? undefined : normalizeText(input.description, 'description');
    const defaultKeyword = input.defaultKeyword === undefined
      ? current.defaultKeyword
      : input.defaultKeyword === null ? undefined : normalizeText(input.defaultKeyword, 'defaultKeyword');
    const applicationFilterInput = input.applicationFilterInput === undefined
      ? cloneInput(current.applicationFilterInput)
      : normalizeApplicationFilterInput(input.applicationFilterInput);
    this.assertNotEmpty(defaultKeyword, applicationFilterInput);
    await this.assertUniqueName(reference.platform, name, reference.conditionSetId);
    if (name === current.name
      && description === current.description
      && defaultKeyword === current.defaultKeyword
      && sameConditions(applicationFilterInput, current.applicationFilterInput)) {
      return current;
    }
    const revision = await this.buildRevision({
      conditionSetId: current.conditionSetId,
      platform: current.platform,
      revision: current.revision + 1,
      name,
      description,
      defaultKeyword,
      applicationFilterInput,
      status: 'active',
      createdAt: current.createdAt,
    });
    await this.store.appendRevision(revision, input.expectedRevision);
    return revision;
  }

  async clone(input: CloneSearchConditionSetInput): Promise<SearchConditionSetRevision> {
    const source = await this.store.getRevision(input.source);
    return this.create({
      platform: source.platform,
      name: input.name,
      description: input.description ?? source.description,
      defaultKeyword: input.defaultKeyword ?? source.defaultKeyword,
      applicationFilterInput: source.applicationFilterInput,
    });
  }

  async archive(
    reference: Pick<SearchConditionSetReference, 'platform' | 'conditionSetId'>,
    input: ArchiveSearchConditionSetInput,
  ): Promise<SearchConditionSetRevision> {
    const current = await this.store.getCurrent(reference.platform, reference.conditionSetId);
    if (current.revision !== input.expectedRevision) {
      throw new SearchConditionSetConflictError({
        ...reference,
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
      });
    }
    if (current.status === 'archived') {
      return current;
    }
    const revision: SearchConditionSetRevision = {
      ...current,
      revision: current.revision + 1,
      applicationFilterInput: cloneInput(current.applicationFilterInput),
      compiledConditions: JSON.parse(JSON.stringify(current.compiledConditions)) as SearchConditionSetRevision['compiledConditions'],
      catalogEvidence: { ...current.catalogEvidence },
      status: 'archived',
      updatedAt: this.now().toISOString(),
    };
    await this.store.appendRevision(revision, input.expectedRevision);
    return revision;
  }

  async resolve(reference: SearchConditionSetReference): Promise<ResolvedSearchConditionSet> {
    const current = await this.store.getCurrent(reference.platform, reference.conditionSetId);
    if (current.status === 'archived') {
      throw new SearchConditionSetArchivedError(reference);
    }
    const revision = await this.store.getRevision(reference);
    if (revision.status === 'archived') {
      throw new SearchConditionSetArchivedError(reference);
    }

    try {
      const compiled = await this.compile(reference.platform, revision.applicationFilterInput);
      if (!sameConditions(compiled.conditions, revision.compiledConditions)) {
        throw new SearchConditionSetCatalogDriftError({
          reference,
          storedFingerprint: revision.catalogEvidence.selectedFieldsFingerprint,
          currentFingerprint: compiled.catalogEvidence.selectedFieldsFingerprint,
          fieldErrors: [{
            fieldId: 'applicationFilterInput',
            code: 'compiled_conditions_changed',
            message: 'The current catalog compiles this condition set to different search conditions.',
            source: 'catalog_drift',
          }],
        });
      }
      return {
        reference: { ...reference },
        revision,
        applicationFilterInput: cloneInput(revision.applicationFilterInput),
        conditions: compiled.conditions,
        catalogEvidence: compiled.catalogEvidence,
        catalogChanged: compiled.catalogEvidence.selectedFieldsFingerprint !== revision.catalogEvidence.selectedFieldsFingerprint,
      };
    } catch (error) {
      if (error instanceof SearchConditionSetCatalogDriftError) {
        throw error;
      }
      if (error instanceof SearchConditionSetValidationError) {
        throw new SearchConditionSetCatalogDriftError({
          reference,
          storedFingerprint: revision.catalogEvidence.selectedFieldsFingerprint,
          currentFingerprint: 'unavailable',
          fieldErrors: error.fieldErrors.map((fieldError) => ({ ...fieldError, source: 'catalog_drift' })),
        });
      }
      throw error;
    }
  }

  async checkCompatibility(revision: SearchConditionSetRevision): Promise<SearchConditionSetCompatibility> {
    const checkedAt = this.now().toISOString();
    if (revision.status === 'archived') {
      return { status: 'unknown', checkedAt, message: 'The condition set is archived.' };
    }
    try {
      const resolved = await this.resolve({
        conditionSetId: revision.conditionSetId,
        platform: revision.platform,
        revision: revision.revision,
      });
      return {
        status: resolved.catalogChanged ? 'drifted' : 'compatible',
        checkedAt,
        selectedFieldsFingerprint: resolved.catalogEvidence.selectedFieldsFingerprint,
        ...(resolved.catalogChanged ? { message: 'Current catalog changed but keeps the same condition semantics.' } : {}),
      };
    } catch (error) {
      if (error instanceof SearchConditionSetCatalogDriftError) {
        return {
          status: 'incompatible',
          checkedAt,
          selectedFieldsFingerprint: error.currentFingerprint,
          message: error.message,
          errors: error.fieldErrors,
        };
      }
      if (error instanceof SearchConditionSetArchivedError) {
        return { status: 'unknown', checkedAt, message: error.message };
      }
      throw error;
    }
  }
}

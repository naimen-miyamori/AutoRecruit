import type { SupportedPlatform } from '../platforms/types.js';
import type { SearchCondition } from '../types/job.js';
import type { ValidateApplicationFilterInputError } from './filter-application-options.js';

export const SEARCH_CONDITION_SET_SCHEMA_VERSION = 1 as const;

export type SearchConditionSetStatus = 'active' | 'archived';

export interface SearchConditionSetReference {
  conditionSetId: string;
  platform: SupportedPlatform;
  revision: number;
}

export interface SearchConditionSetCatalogEvidence {
  capturedAt: string;
  selectedFieldsFingerprint: string;
}

export interface SearchConditionSetRevision extends SearchConditionSetReference {
  schemaVersion: typeof SEARCH_CONDITION_SET_SCHEMA_VERSION;
  name: string;
  description?: string;
  defaultKeyword?: string;
  applicationFilterInput: Record<string, unknown>;
  compiledConditions: SearchCondition[];
  catalogEvidence: SearchConditionSetCatalogEvidence;
  status: SearchConditionSetStatus;
  createdAt: string;
  updatedAt: string;
}

/** The small current-version record stored in `current.json` and returned by lists. */
export interface SearchConditionSetSummary {
  schemaVersion: typeof SEARCH_CONDITION_SET_SCHEMA_VERSION;
  conditionSetId: string;
  platform: SupportedPlatform;
  revision: number;
  name: string;
  description?: string;
  defaultKeyword?: string;
  status: SearchConditionSetStatus;
  fieldIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SearchConditionSetListOptions {
  platform?: SupportedPlatform;
  status?: SearchConditionSetStatus;
}

export interface CreateSearchConditionSetInput {
  platform: SupportedPlatform;
  name: string;
  description?: string;
  defaultKeyword?: string;
  applicationFilterInput: Record<string, unknown>;
}

export interface ReviseSearchConditionSetInput {
  expectedRevision: number;
  name?: string;
  description?: string | null;
  defaultKeyword?: string | null;
  applicationFilterInput?: Record<string, unknown>;
}

export interface CloneSearchConditionSetInput {
  /** The source revision to clone. It may be archived. */
  source: SearchConditionSetReference;
  name: string;
  description?: string;
  defaultKeyword?: string;
}

export interface ArchiveSearchConditionSetInput {
  expectedRevision: number;
}

export interface ResolvedSearchConditionSet {
  reference: SearchConditionSetReference;
  revision: SearchConditionSetRevision;
  applicationFilterInput: Record<string, unknown>;
  conditions: SearchCondition[];
  catalogEvidence: SearchConditionSetCatalogEvidence;
  /** True when the current catalog changed but produces equivalent conditions. */
  catalogChanged: boolean;
}

export interface SearchConditionSetFieldError extends ValidateApplicationFilterInputError {
  /** Distinguishes a current-catalog incompatibility from create/update validation. */
  source?: 'catalog_drift';
}

export class SearchConditionSetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SearchConditionSetError';
    this.code = code;
  }
}

export class SearchConditionSetNotFoundError extends SearchConditionSetError {
  constructor(reference: Pick<SearchConditionSetReference, 'conditionSetId' | 'platform'> & { revision?: number }) {
    super(
      'not_found',
      `Search condition set ${reference.conditionSetId}${reference.revision ? `@${reference.revision}` : ''} was not found for ${reference.platform}.`,
    );
    this.name = 'SearchConditionSetNotFoundError';
  }
}

export class SearchConditionSetConflictError extends SearchConditionSetError {
  readonly reference: Pick<SearchConditionSetReference, 'conditionSetId' | 'platform'>;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(input: {
    conditionSetId: string;
    platform: SupportedPlatform;
    expectedRevision: number;
    actualRevision: number;
  }) {
    super(
      'revision_conflict',
      `Search condition set ${input.conditionSetId} is revision ${input.actualRevision}, not expected revision ${input.expectedRevision}.`,
    );
    this.name = 'SearchConditionSetConflictError';
    this.reference = {
      conditionSetId: input.conditionSetId,
      platform: input.platform,
    };
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
  }
}

export class SearchConditionSetValidationError extends SearchConditionSetError {
  readonly fieldErrors: SearchConditionSetFieldError[];

  constructor(message: string, fieldErrors: SearchConditionSetFieldError[]) {
    super('validation_failed', message);
    this.name = 'SearchConditionSetValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export class SearchConditionSetCatalogDriftError extends SearchConditionSetError {
  readonly reference: SearchConditionSetReference;
  readonly storedFingerprint: string;
  readonly currentFingerprint: string;
  readonly fieldErrors: SearchConditionSetFieldError[];

  constructor(input: {
    reference: SearchConditionSetReference;
    storedFingerprint: string;
    currentFingerprint: string;
    fieldErrors: SearchConditionSetFieldError[];
  }) {
    super(
      'catalog_drift',
      `Search condition set ${input.reference.conditionSetId}@${input.reference.revision} is incompatible with the current ${input.reference.platform} filter catalog.`,
    );
    this.name = 'SearchConditionSetCatalogDriftError';
    this.reference = input.reference;
    this.storedFingerprint = input.storedFingerprint;
    this.currentFingerprint = input.currentFingerprint;
    this.fieldErrors = input.fieldErrors;
  }
}

export class SearchConditionSetArchivedError extends SearchConditionSetError {
  readonly reference: SearchConditionSetReference;

  constructor(reference: SearchConditionSetReference) {
    super(
      'archived',
      `Search condition set ${reference.conditionSetId}@${reference.revision} is archived and cannot be newly resolved.`,
    );
    this.name = 'SearchConditionSetArchivedError';
    this.reference = reference;
  }
}

export class SearchConditionSetStorageError extends SearchConditionSetError {
  constructor(code: 'invalid_id' | 'corrupt_storage' | 'duplicate_id', message: string) {
    super(code, message);
    this.name = 'SearchConditionSetStorageError';
  }
}

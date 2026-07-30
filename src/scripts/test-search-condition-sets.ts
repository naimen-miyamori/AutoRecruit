import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ApplicationFilterOptions } from '../search/filter-application-options.js';
import {
  SearchConditionSetArchivedError,
  SearchConditionSetCatalogDriftError,
  SearchConditionSetConflictError,
  SearchConditionSetService,
  SearchConditionSetValidationError,
} from '../search/search-condition-sets.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-search-condition-sets-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function applicationOptions(overrides: Partial<ApplicationFilterOptions> = {}): ApplicationFilterOptions {
  return {
    platform: '51job',
    capturedAt: '2026-07-30T00:00:00.000Z',
    keyword: '资深设计师',
    fieldCount: 1,
    fieldIds: ['education'],
    fieldIdByLabel: { 学历: 'education' },
    groups: {
      singleSelect: ['education'],
      textInput: [],
      salaryRange: [],
      numberRange: [],
    },
    fieldsById: {
      education: {
        fieldId: 'education',
        filterKey: 'education-filter',
        label: '学历',
        kind: 'singleSelect',
        restrictInput: true,
        valueShape: 'string',
        acceptedInputShapes: ['string'],
        allowedValues: ['大专', '本科'],
        options: [
          { label: '大专', value: '大专', disabled: false, selected: false },
          { label: '本科', value: '本科', disabled: false, selected: false },
        ],
      },
    },
    ...overrides,
  };
}

async function writeOptions(options: ApplicationFilterOptions): Promise<void> {
  const outputPath = path.join(tempDir, options.platform, 'filter-catalog', 'application-filter-options.latest.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(options, null, 2)}\n`, 'utf8');
}

function service(): SearchConditionSetService {
  return new SearchConditionSetService({ dataDir: tempDir });
}

describe('SearchConditionSetService', () => {
  it('creates immutable revisions, resolves a fixed reference, and archives without deleting history', async () => {
    await writeOptions(applicationOptions());
    const searchConditionSets = service();
    const created = await searchConditionSets.create({
      platform: '51job',
      name: '  广东资深设计师  ',
      defaultKeyword: ' 铝 ',
      applicationFilterInput: { education: '本科' },
    });

    assert.match(created.conditionSetId, /^scs-[a-z0-9-]+$/);
    assert.equal(created.revision, 1);
    assert.equal(created.name, '广东资深设计师');
    assert.equal(created.defaultKeyword, '铝');
    const resolved = await searchConditionSets.resolve({
      conditionSetId: created.conditionSetId,
      platform: '51job',
      revision: 1,
    });
    assert.deepStrictEqual(resolved.applicationFilterInput, { education: '本科' });
    assert.equal(resolved.conditions[0]?.kind, 'applicationFilter');

    const revised = await searchConditionSets.revise({
      conditionSetId: created.conditionSetId,
      platform: '51job',
    }, {
      expectedRevision: 1,
      description: '只用于广东招聘',
    });
    assert.equal(revised.revision, 2);
    assert.equal((await searchConditionSets.get({ platform: '51job', conditionSetId: created.conditionSetId })).revisions.length, 2);
    assert.equal((await searchConditionSets.resolve({ ...resolved.reference })).reference.revision, 1);

    const archived = await searchConditionSets.archive({
      conditionSetId: created.conditionSetId,
      platform: '51job',
    }, { expectedRevision: 2 });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.revision, 3);
    await assert.rejects(
      () => searchConditionSets.resolve({ conditionSetId: created.conditionSetId, platform: '51job', revision: 2 }),
      SearchConditionSetArchivedError,
    );
    assert.equal((await searchConditionSets.get({ platform: '51job', conditionSetId: created.conditionSetId })).revisions.length, 3);
  });

  it('rejects duplicate names and concurrent revisions rather than overwriting a set', async () => {
    await writeOptions(applicationOptions());
    const searchConditionSets = service();
    const created = await searchConditionSets.create({
      platform: '51job',
      name: '资深设计师',
      applicationFilterInput: { education: '本科' },
    });

    await assert.rejects(
      () => searchConditionSets.create({
        platform: '51job',
        name: '　资深设计师　',
        applicationFilterInput: { education: '大专' },
      }),
      SearchConditionSetValidationError,
    );

    const attempts = await Promise.allSettled([
      searchConditionSets.revise({ platform: '51job', conditionSetId: created.conditionSetId }, {
        expectedRevision: 1,
        description: '版本 A',
      }),
      searchConditionSets.revise({ platform: '51job', conditionSetId: created.conditionSetId }, {
        expectedRevision: 1,
        description: '版本 B',
      }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    const failed = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    assert.ok(failed?.reason instanceof SearchConditionSetConflictError);
  });

  it('permits irrelevant catalog state changes but blocks incompatible current catalogs before browser work', async () => {
    await writeOptions(applicationOptions());
    const searchConditionSets = service();
    const created = await searchConditionSets.create({
      platform: '51job',
      name: '学历本科',
      applicationFilterInput: { education: '本科' },
    });

    const equivalent = applicationOptions({ capturedAt: '2026-07-31T00:00:00.000Z' });
    const equivalentEducation = equivalent.fieldsById.education;
    assert.equal(equivalentEducation.kind, 'singleSelect');
    equivalentEducation.options[0]!.selected = true;
    await writeOptions(equivalent);
    const equivalentResolution = await searchConditionSets.resolve({
      conditionSetId: created.conditionSetId,
      platform: '51job',
      revision: 1,
    });
    assert.equal(equivalentResolution.catalogChanged, false);

    const incompatible = applicationOptions();
    const incompatibleEducation = incompatible.fieldsById.education;
    assert.equal(incompatibleEducation.kind, 'singleSelect');
    incompatibleEducation.allowedValues = ['大专'];
    incompatibleEducation.options = [{ label: '大专', value: '大专', disabled: false, selected: false }];
    await writeOptions(incompatible);
    await assert.rejects(
      () => searchConditionSets.resolve({ conditionSetId: created.conditionSetId, platform: '51job', revision: 1 }),
      SearchConditionSetCatalogDriftError,
    );
  });
});

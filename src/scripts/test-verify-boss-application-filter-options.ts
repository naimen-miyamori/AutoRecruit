import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ApplicationFilterOptions } from '../search/filter-application-options.js';
import {
  buildBossApplicationFilterOptionVerificationCases,
  parseArgs,
  verifyBossApplicationFilterOptions,
} from './verify-boss-application-filter-options.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-option-verify-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function createOptions(): ApplicationFilterOptions {
  return {
    platform: 'boss', capturedAt: '2026-07-29T00:00:00.000Z', keyword: 'test', fieldCount: 4,
    fieldIds: ['education', 'school_nature', 'filter_recent_viewed', 'major'],
    fieldIdByLabel: { 学历要求: 'education', 院校要求: 'school_nature', 过滤近14天查看: 'filter_recent_viewed', 专业: 'major' },
    groups: { singleSelect: ['education'], multiSelect: ['school_nature'], toggle: ['filter_recent_viewed'], textInput: ['major'], salaryRange: [], numberRange: [] },
    fieldsById: {
      education: {
        fieldId: 'education', filterKey: 'boss-education', label: '学历要求', kind: 'singleSelect', restrictInput: true, valueShape: 'string',
        acceptedInputShapes: ['string', 'customInput'], allowedValues: ['不限', '本科及以上'],
        options: [
          { label: '不限', value: '不限', disabled: false, selected: false },
          { label: '本科及以上', value: '本科及以上', disabled: false, selected: false },
          { label: '自定义', value: '自定义', disabled: false, selected: false, inputSpec: { kind: 'selectRange', fields: [{ key: 'min', valueType: 'string' }, { key: 'max', valueType: 'string' }] } },
        ],
        customInput: { label: '自定义', value: '自定义', inputSpec: { kind: 'selectRange', fields: [{ key: 'min', valueType: 'string' }, { key: 'max', valueType: 'string' }] } },
      },
      school_nature: {
        fieldId: 'school_nature', filterKey: 'boss-school-nature', label: '院校要求', kind: 'multiSelect', restrictInput: true, valueShape: 'string[]',
        acceptedInputShapes: ['string[]'], allowedValues: ['不限', '统招本科', '985院校'],
        options: [
          { label: '不限', value: '不限', disabled: false, selected: false },
          { label: '统招本科', value: '统招本科', disabled: false, selected: false },
          { label: '985院校', value: '985院校', disabled: false, selected: false },
        ],
      },
      filter_recent_viewed: {
        fieldId: 'filter_recent_viewed', filterKey: 'boss-filter-recent-viewed', label: '过滤近14天查看', kind: 'toggle', restrictInput: true,
        valueShape: 'boolean', acceptedInputShapes: ['boolean'], defaultValue: false,
      },
      major: {
        fieldId: 'major', filterKey: 'boss-major', label: '专业', kind: 'textInput', semanticKind: 'other', scope: 'other', restrictInput: true,
        valueShape: 'string|string[]', acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
        allowedValues: [], rootValues: [], valuesByDepth: [], tree: [],
      },
    },
  };
}

test('Boss option verifier plans every finite multi/toggle state and exposes policy gaps', () => {
  const cases = buildBossApplicationFilterOptionVerificationCases(createOptions(), {
    offset: 0, includeDefaults: true, run: false,
  });
  assert.deepEqual(cases.filter((item) => item.fieldId === 'school_nature').map((item) => item.applicationFilterInput), [
    { school_nature: ['不限'] },
    { school_nature: ['统招本科'] },
    { school_nature: ['985院校'] },
    { school_nature: ['统招本科', '985院校'] },
  ]);
  assert.deepEqual(cases.filter((item) => item.fieldId === 'filter_recent_viewed').map((item) => item.applicationFilterInput), [
    { filter_recent_viewed: false },
    { filter_recent_viewed: true },
  ]);
  assert.equal(cases.find((item) => item.valueLabel === '自定义')?.runnable, false);
  assert.match(cases.find((item) => item.fieldId === 'major')?.skipReason ?? '', /Dynamic suggestion/);
});

test('Boss option verifier excludes the custom-slider full range because the page normalizes it to the unrestricted state', () => {
  const options = createOptions();
  const education = options.fieldsById.education as Extract<ApplicationFilterOptions['fieldsById'][string], { kind: 'singleSelect' }>;
  const custom = education.options[2]!;
  custom.inputSpec = {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', options: ['1', '2', '3'] },
      { key: 'max', valueType: 'string', options: ['1', '2', '3'] },
    ],
  };
  const cases = buildBossApplicationFilterOptionVerificationCases(options, {
    offset: 0, includeDefaults: true, run: false,
  }).filter((item) => item.fieldId === 'education');
  const customValues = cases
    .map((item) => item.applicationFilterInput.education)
    .filter((value): value is { input: { min: string; max: string } } => typeof value === 'object' && value !== null && !Array.isArray(value));
  assert.equal(customValues.some((value) => value.input.min === '1' && value.input.max === '3'), false);
  assert.equal(customValues.some((value) => value.input.min === '2' && value.input.max === '3'), true);
});

test('Boss option verifier writes sliced dry-run plans', async () => {
  const optionsPath = path.join(tempDir, 'options.json');
  const outputPath = path.join(tempDir, 'plan.json');
  await fs.writeFile(optionsPath, `${JSON.stringify(createOptions())}\n`, 'utf8');
  const summary = await verifyBossApplicationFilterOptions({
    optionsPath, outputPath, offset: 1, limit: 2, includeDefaults: true, run: false,
  });
  assert.equal(summary.selectedCases, 2);
  assert.equal(summary.plannedCases, 1);
  assert.equal((JSON.parse(await fs.readFile(outputPath, 'utf8')) as { cases: unknown[] }).cases.length, 2);
});

test('Boss option verifier parses standard planning arguments', () => {
  assert.deepEqual(parseArgs(['--field', 'school_nature,filter_recent_viewed', '--offset', '2', '--limit', '3', '--include-defaults', 'false']), {
    optionsPath: undefined, outputPath: undefined, fieldIds: ['school_nature', 'filter_recent_viewed'], offset: 2, limit: 3, includeDefaults: false, run: false, stopOnFailure: true,
  });
  assert.equal(parseArgs(['--run', 'true']).run, true);
});

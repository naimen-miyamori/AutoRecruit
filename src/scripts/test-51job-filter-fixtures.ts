import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import {
  validateApplicationFilterInput,
  type ApplicationFilterOptions,
  type ApplicationFilterSingleSelectField,
  type ApplicationFilterSalaryRangeField,
} from '../search/filter-application-options.js';

async function readApplicationFilterOptions(): Promise<ApplicationFilterOptions> {
  return fs.readFile('fixtures/51job-filter-options.all.example.json', 'utf8')
    .then((content) => JSON.parse(content) as ApplicationFilterOptions);
}

function assertValidApplicationFilterInput(
  options: ApplicationFilterOptions,
  input: Record<string, unknown>,
  context: string,
): void {
  const result = validateApplicationFilterInput(options, input);
  assert.equal(result.ok, true, `${context}: ${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.errors, [], context);
}

function buildValidCustomInput(field: ApplicationFilterSingleSelectField): Record<string, unknown> {
  const customInput = field.customInput;
  assert.ok(customInput, `${field.fieldId} should have a custom input option`);

  const input: Record<string, unknown> = {};
  for (const inputField of customInput.inputSpec.fields) {
    if (inputField.valueType === 'number') {
      input[inputField.key] = inputField.key === 'max' ? 3 : 1;
    } else {
      input[inputField.key] = inputField.key === 'max' ? '本科' : '大专';
    }
  }

  return {
    label: customInput.label,
    input,
  };
}

function parseSalaryFixtureValue(value: string): number | undefined {
  if (value === '不限') {
    return 0;
  }

  const matched = value.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(千|万)/);
  if (!matched) {
    return undefined;
  }

  const amount = Number(matched[1]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return matched[2] === '万' ? amount * 10000 : amount * 1000;
}

function isValidSalaryPair(field: ApplicationFilterSalaryRangeField, min: string, max: string): boolean {
  const minValue = parseSalaryFixtureValue(min);
  const maxValue = parseSalaryFixtureValue(max);

  if (minValue === undefined) {
    throw new Error(`${field.fieldId} has unparsable min option: ${min}`);
  }
  if (maxValue === undefined) {
    throw new Error(`${field.fieldId} has unparsable max option: ${max}`);
  }

  return maxValue >= minValue;
}

test('51job filter input fixture covers every current application field', async () => {
  const [options, input] = await Promise.all([
    readApplicationFilterOptions(),
    fs.readFile('fixtures/51job-filter-input.example.json', 'utf8')
      .then((content) => JSON.parse(content) as Record<string, unknown>),
  ]);

  assert.deepEqual(Object.keys(input), options.fieldIds);
  assert.deepEqual(validateApplicationFilterInput(options, input), {
    ok: true,
    errors: [],
  });
});

test('51job all-options fixture mirrors current application option pools', async () => {
  const options = await readApplicationFilterOptions();

  assert.equal(options.fieldCount, options.fieldIds.length);
  assert.deepEqual(Object.keys(options.fieldsById), options.fieldIds);

  for (const fieldId of options.fieldIds) {
    const expectedField = options.fieldsById[fieldId];
    assert.ok(expectedField, `${fieldId} should exist in fieldsById`);

    if (expectedField.kind === 'singleSelect' || expectedField.kind === 'textInput') {
      assert.ok(expectedField.allowedValues.length > 0, `${fieldId} should expose allowedValues`);
      continue;
    }

    if (expectedField.kind === 'salaryRange' || expectedField.kind === 'numberRange') {
      assert.ok(expectedField.minOptions.length > 0, `${fieldId} should expose minOptions`);
      assert.ok(expectedField.maxOptions.length > 0, `${fieldId} should expose maxOptions`);
    }
  }
});

test('51job application filter input accepts every collected option value', async () => {
  const options = await readApplicationFilterOptions();
  const coverage = {
    singleSelectValues: 0,
    customInputs: 0,
    textInputValues: 0,
    textInputArrayPayloads: 0,
    salaryPairs: 0,
  };

  for (const fieldId of options.fieldIds) {
    const field = options.fieldsById[fieldId];

    if (field.kind === 'singleSelect') {
      for (const value of field.allowedValues) {
        assertValidApplicationFilterInput(
          options,
          { [fieldId]: value },
          `${fieldId} accepts single-select option ${value}`,
        );
        coverage.singleSelectValues += 1;
      }

      if (field.customInput) {
        assertValidApplicationFilterInput(
          options,
          { [fieldId]: buildValidCustomInput(field) },
          `${fieldId} accepts custom input`,
        );
        coverage.customInputs += 1;
      }

      continue;
    }

    if (field.kind === 'textInput') {
      for (const value of field.allowedValues) {
        assertValidApplicationFilterInput(
          options,
          { [fieldId]: value },
          `${fieldId} accepts text option ${value}`,
        );
        coverage.textInputValues += 1;
      }

      assertValidApplicationFilterInput(
        options,
        { [fieldId]: field.allowedValues },
        `${fieldId} accepts all text options as an array`,
      );
      coverage.textInputArrayPayloads += 1;
      continue;
    }

    if (field.kind !== 'salaryRange') {
      continue;
    }

    for (const min of field.minOptions) {
      let legalMaxOptions = 0;
      for (const max of field.maxOptions) {
        if (!isValidSalaryPair(field, min, max)) {
          continue;
        }

        assertValidApplicationFilterInput(
          options,
          {
            [fieldId]: {
              min,
              max,
            },
          },
          `${fieldId} accepts salary range ${min}-${max}`,
        );
        coverage.salaryPairs += 1;
        legalMaxOptions += 1;
      }

      assert.ok(legalMaxOptions > 0, `${fieldId} min option ${min} should have a legal max option`);
    }
  }

  assert.deepEqual(coverage, {
    singleSelectValues: 100,
    customInputs: 4,
    textInputValues: 9873,
    textInputArrayPayloads: 7,
    salaryPairs: 1885,
  });
});

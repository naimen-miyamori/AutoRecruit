import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../index.js';
import {
  assertOperationModeCatalogIntegrity,
  compileSearchOperationMode,
  deriveCliSearchModeId,
  listOperationModeDefinitionsForPicker,
  listOperationModePickerGroups,
  listOperationModeDefinitions,
  resolveOperationModeEffects,
} from '../operation-modes.js';
import { parseOperationModeCatalogResponse } from '../server/api-contracts.js';
import { handleApiRequest } from '../server/routes.js';
import { readRequiredModeId, runSearchOperation } from './run-search-operation.js';
import {
  normalizeBatchTask,
  normalizeResumeCaptureTask,
  normalizeSearchSubscriptionTask,
} from '../server/task-normalizers.js';

test('operation mode derivation distinguishes capture, batch, and management', () => {
  assert.equal(deriveCliSearchModeId({ mode: 'single', searchSourceExplicit: false, searchSource: 'saved' }), 'capture.reuse-job-settings');
  assert.equal(deriveCliSearchModeId({ mode: 'single', searchSourceExplicit: true, searchSource: 'saved' }), 'capture.subscription-search');
  assert.equal(deriveCliSearchModeId({ mode: 'single', searchSourceExplicit: true, searchSource: 'direct' }), 'capture.direct-search');
  assert.equal(deriveCliSearchModeId({ mode: 'batch', searchSourceExplicit: true, searchSource: 'direct' }), 'batch.capture');
  assert.equal(deriveCliSearchModeId({ mode: 'search-subscription' }), 'subscription.manage');
  assert.deepEqual(compileSearchOperationMode('capture.reuse-job-settings'), { taskKind: 'resume-capture' });
  assert.deepEqual(compileSearchOperationMode('capture.subscription-search'), { taskKind: 'resume-capture', searchSource: 'saved' });
  assert.deepEqual(compileSearchOperationMode('capture.direct-search'), { taskKind: 'resume-capture', searchSource: 'direct' });
  assert.deepEqual(compileSearchOperationMode('batch.capture'), { taskKind: 'batch' });
  assert.deepEqual(compileSearchOperationMode('subscription.manage'), { taskKind: 'search-subscription' });
  assert.throws(() => compileSearchOperationMode('unknown-mode' as never), /operation-mode-unknown/);
  assert.match(resolveOperationModeEffects('subscription.manage', { saveSearchSubscription: true }), /保存或更新/);
  assert.match(resolveOperationModeEffects('subscription.manage', { searchSource: 'saved' }), /不会保存订阅/);
});

test('operation mode picker metadata has precise uniqueness rules', () => {
  assert.doesNotThrow(assertOperationModeCatalogIntegrity);
  assert.deepEqual(
    listOperationModeDefinitionsForPicker('manual-search-create').map((definition) => definition.modeId),
    [
      'capture.reuse-job-settings',
      'capture.subscription-search',
      'capture.direct-search',
      'batch.capture',
      'subscription.manage',
    ],
  );
  assert.deepEqual(
    listOperationModeDefinitionsForPicker('schedule-search-create').map((definition) => definition.modeId),
    [
      'capture.reuse-job-settings',
      'capture.subscription-search',
      'capture.direct-search',
      'batch.capture',
      'subscription.manage',
    ],
  );
  assert.equal(listOperationModePickerGroups('manual-search-create').length, 3);
  assert.equal(listOperationModeDefinitions().filter((definition) => definition.taskKind === 'resume-capture').length, 3);
  for (const definition of listOperationModeDefinitionsForPicker('manual-search-create')) {
    assert.match(definition.effectSummary, /会做：/);
    assert.match(definition.effectSummary, /不会做：/);
    assert.match(definition.effectSummary, /外部变化：/);
  }
});

test('queue normalizers persist and assert the resolved operation mode', () => {
  const reused = normalizeResumeCaptureTask({ platform: '51job', keyword: '铝镁合金' });
  assert.equal(reused.inputSummary.modeId, 'capture.reuse-job-settings');
  assert.equal(reused.argv[0], '--mode-id');
  assert.equal(reused.argv[1], 'capture.reuse-job-settings');

  const direct = normalizeResumeCaptureTask({ platform: '51job', keyword: '铝镁合金', searchSource: 'direct' });
  assert.equal(direct.inputSummary.modeId, 'capture.direct-search');
  assert.match(String(direct.inputSummary.resolvedEffects), /直接搜索条件/);

  const batch = normalizeBatchTask({ platform: 'all', jobsFile: './jobs.json', searchSource: 'saved' });
  assert.equal(batch.inputSummary.modeId, 'batch.capture');

  const managed = normalizeSearchSubscriptionTask({
    platform: '51job',
    searchSubscriptionFile: './search-subscription.json',
    saveSearchSubscription: true,
  });
  assert.equal(managed.inputSummary.modeId, 'subscription.manage');
  assert.match(String(managed.inputSummary.resolvedEffects), /保存或更新/);
});

test('operation mode catalog exposes manual boundaries', async () => {
  const response = await handleApiRequest({
    method: 'GET',
    pathname: '/api/operation-modes',
    searchParams: new URLSearchParams('surface=manual'),
  });
  assert.equal(response.statusCode, 200);
  const catalog = parseOperationModeCatalogResponse(response.body, { surface: 'manual' });
  assert.ok(catalog.modes.some((mode) => mode.modeId === 'capture.subscription-search'));
  assert.ok(catalog.modes.some((mode) => mode.modeId === 'boss.auto-chat'));
  assert.ok(catalog.modes.some((mode) => mode.modeId === 'rag.answer'));
  assert.ok(catalog.modes.every((mode) => mode.declaredEffects.length > 0));
  assert.deepEqual(
    catalog.modes.filter((mode) => mode.pickerTargets.includes('manual-search-create')).map((mode) => mode.modeId),
    [
      'capture.reuse-job-settings',
      'capture.subscription-search',
      'capture.direct-search',
      'batch.capture',
      'subscription.manage',
    ],
  );
  assert.equal(listOperationModeDefinitions('manual').length, catalog.modes.length);
  assert.ok(listOperationModeDefinitions('manual').some((mode) => mode.modeId === 'boss.auto-chat'));
  assert.ok(listOperationModeDefinitions('manual').some((mode) => mode.modeId === 'rag.answer'));
  assert.ok(listOperationModeDefinitions('schedule').some((mode) => mode.modeId === 'session.login-refresh'));

  for (const surface of ['assistant', 'manual', 'schedule', 'cli'] as const) {
    const surfaceResponse = await handleApiRequest({
      method: 'GET',
      pathname: '/api/operation-modes',
      searchParams: new URLSearchParams(`surface=${surface}`),
    });
    assert.equal(surfaceResponse.statusCode, 200);
    assert.doesNotThrow(() => parseOperationModeCatalogResponse(surfaceResponse.body, { surface }));
  }
  const unscopedResponse = await handleApiRequest({ method: 'GET', pathname: '/api/operation-modes', searchParams: new URLSearchParams() });
  assert.equal(unscopedResponse.statusCode, 200);
  assert.doesNotThrow(() => parseOperationModeCatalogResponse(unscopedResponse.body));

  const duplicateModeCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  duplicateModeCatalog.modes.push(catalog.modes[0]!);
  assert.throws(() => parseOperationModeCatalogResponse(duplicateModeCatalog, { surface: 'manual' }), /duplicate modeId/);
  const mismatchedEffectsCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  mismatchedEffectsCatalog.modes[0]!.declaredEffects = '篡改后的副作用描述';
  assert.throws(() => parseOperationModeCatalogResponse(mismatchedEffectsCatalog, { surface: 'manual' }), /effect mismatch/);
  const duplicateGroupOrderCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  duplicateGroupOrderCatalog.groups.push({ groupId: 'unexpected-group', label: '额外分组', orders: { 'manual-search-create': 10 } });
  assert.throws(() => parseOperationModeCatalogResponse(duplicateGroupOrderCatalog, { surface: 'manual' }), /duplicate group order/);
  const duplicatePickerTupleCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  duplicatePickerTupleCatalog.modes.find((mode) => mode.modeId === 'capture.direct-search')!.pickerOrder = 20;
  assert.throws(() => parseOperationModeCatalogResponse(duplicatePickerTupleCatalog, { surface: 'manual' }), /duplicate picker tuple/);
  const extraPickerModeCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  extraPickerModeCatalog.modes.find((mode) => mode.modeId === 'talent-mapping.run')!.pickerTargets = ['manual-search-create'];
  assert.throws(() => parseOperationModeCatalogResponse(extraPickerModeCatalog, { surface: 'manual' }), /picker target declarations talent-mapping.run/);
  const mappingConflictCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  mappingConflictCatalog.modes.find((mode) => mode.modeId === 'capture.subscription-search')!.searchSource = 'direct';
  assert.throws(() => parseOperationModeCatalogResponse(mappingConflictCatalog, { surface: 'manual' }), /operation mapping mismatch/);
  const surfaceDriftCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  surfaceDriftCatalog.modes.find((mode) => mode.modeId === 'capture.subscription-search')!.surfaces = ['manual'];
  assert.throws(() => parseOperationModeCatalogResponse(surfaceDriftCatalog, { surface: 'manual' }), /surface declarations/);
  const pickerTargetDriftCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  pickerTargetDriftCatalog.modes.find((mode) => mode.modeId === 'capture.subscription-search')!.pickerTargets = ['manual-search-create'];
  assert.throws(() => parseOperationModeCatalogResponse(pickerTargetDriftCatalog, { surface: 'manual' }), /picker target declarations/);
  assert.throws(() => parseOperationModeCatalogResponse(null, { surface: 'manual' }), /operation-mode-catalog-shape/);
  const scheduleDefinitions = listOperationModeDefinitionsForPicker('schedule-search-create').map((definition) => definition.modeId);
  assert.deepEqual(scheduleDefinitions, [
    'capture.reuse-job-settings',
    'capture.subscription-search',
    'capture.direct-search',
    'batch.capture',
    'subscription.manage',
  ]);
});

test('CLI mode assertion rejects a conflicting explicit mode before execution', async () => {
  await assert.rejects(
    main(['--mode-id', 'capture.subscription-search', '--platform', '51job', '--keyword', '铝镁合金']),
    /operation-mode-conflict: .*订阅搜索.*capture\.subscription-search.*按岗位设置抓取.*capture\.reuse-job-settings.*一致后再重试/,
  );
  await assert.rejects(
    main(['--mode-id', '', '--platform', '51job', '--keyword', '铝镁合金']),
    /operation-mode-unknown/,
  );
});

test('search safety launcher requires one supported mode before calling main', async () => {
  assert.equal(readRequiredModeId(['--mode-id', 'capture.direct-search']), 'capture.direct-search');
  assert.throws(() => readRequiredModeId([]), /requires exactly one --mode-id/);
  assert.throws(
    () => readRequiredModeId(['--mode-id', 'capture.direct-search', '--mode-id', 'batch.capture']),
    /requires exactly one --mode-id/,
  );
  assert.throws(() => readRequiredModeId(['--mode-id', 'unsupported.mode']), /operation-mode-unknown/);

  let calls = 0;
  const execute = async (argv: readonly string[]) => {
    calls += 1;
    assert.deepEqual(argv, ['--mode-id', 'batch.capture', '--jobs-file', './jobs.json']);
    return 'executed';
  };
  await assert.rejects(runSearchOperation(['--jobs-file', './jobs.json'], execute), /requires exactly one --mode-id/);
  assert.equal(calls, 0);
  assert.equal(
    await runSearchOperation(['--mode-id', 'batch.capture', '--jobs-file', './jobs.json'], execute),
    'executed',
  );
  assert.equal(calls, 1);
});

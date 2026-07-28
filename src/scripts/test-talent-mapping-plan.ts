import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTalentMappingPlanFile } from '../talent-mapping/plan.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/talent-mapping/retail-operations.example.json', import.meta.url));

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function basePlan() {
  return {
    version: 1,
    mappingKey: 'mapping-test',
    name: '脱敏测试',
    objective: { roleFamilies: ['运营'], locations: ['上海'] },
    taxonomy: {
      targetCompanies: [{ companyKey: 'sample', displayName: '示例公司', aliases: [], tier: 'A' }],
      roleFamilies: [{ roleKey: 'operations', displayName: '运营', titleAliases: ['运营经理'] }],
      levels: ['经理'],
    },
    slices: [{
      sliceId: 'slice-1',
      label: '切片 1',
      platformPlans: {
        '51job': { searchSource: 'direct', searchPlanFile: './plans/51job.json' },
        liepin: { searchSource: 'direct', searchPlanFile: './plans/liepin.json' },
        zhilian: { searchSource: 'direct', searchPlanFile: './plans/zhilian.json' },
      },
    }],
    coverage: { maxBatchesPerSlice: 2, maxCandidatesPerSlice: 20, sliceTimeoutMs: 60000 },
    enrichment: {
      mode: 'targeted-detail',
      maxProfilesPerSlice: 5,
      maxProfilesTotal: 10,
      selection: { targetCompanyTiers: ['A'], samplePerMatrixCell: 2 },
    },
  };
}

async function writePlanTree(tempDir: string, plan: ReturnType<typeof basePlan>): Promise<string> {
  for (const platform of ['51job', 'liepin', 'zhilian']) {
    await writeJson(path.join(tempDir, 'plans', `${platform}.json`), { keyword: `keyword-${platform}`, conditions: [] });
  }
  const planPath = path.join(tempDir, 'mapping.json');
  await writeJson(planPath, plan);
  return planPath;
}

describe('Talent Mapping plan parser', () => {
  it('loads the versioned fixture and resolves search plans relative to the Mapping file', async () => {
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
    assert.equal(plan.version, 1);
    assert.equal(plan.mappingKey, 'retail-operations-shanghai');
    assert.equal(plan.slices.length, 1);
    assert.equal(plan.coverage.maxBatchesPerSlice, 3);
    const platformPlan = plan.slices[0].platformPlans['51job'];
    assert.ok(platformPlan && !platformPlan.disabled);
    assert.equal(platformPlan.searchPlan.keyword, '示例零售 区域运营');
    assert.equal(platformPlan.searchPlanFile, path.resolve(path.dirname(fixturePath), 'plans/51job.json'));
  });

  it('rejects duplicate stable slice IDs and unbounded limits', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-plan-'));
    try {
      const duplicatePlan = basePlan();
      duplicatePlan.slices.push({ ...duplicatePlan.slices[0] });
      await assert.rejects(
        () => writePlanTree(tempDir, duplicatePlan).then((filePath) => loadTalentMappingPlanFile(filePath, { platformSelection: 'all' })),
        /sliceId.*unique/i,
      );

      const unboundedPlan = basePlan();
      unboundedPlan.coverage.maxCandidatesPerSlice = 0;
      await assert.rejects(
        () => writePlanTree(tempDir, unboundedPlan).then((filePath) => loadTalentMappingPlanFile(filePath, { platformSelection: 'all' })),
        /maxCandidatesPerSlice/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('requires every core platform for all, while accepting an explicit disabled plan with a reason', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-platforms-'));
    try {
      const missing = basePlan();
      delete (missing.slices[0].platformPlans as Partial<typeof missing.slices[0]['platformPlans']>).zhilian;
      const missingPath = await writePlanTree(tempDir, missing);
      await assert.rejects(
        () => loadTalentMappingPlanFile(missingPath, { platformSelection: 'all' }),
        /must provide a zhilian platform plan/i,
      );

      const disabled = basePlan();
      disabled.slices[0].platformPlans.zhilian = { disabled: true, reason: '该切片不适用于智联' } as never;
      const disabledPath = await writePlanTree(tempDir, disabled);
      const loaded = await loadTalentMappingPlanFile(disabledPath, { platformSelection: 'all' });
      assert.deepStrictEqual(loaded.slices[0].platformPlans.zhilian, {
        disabled: true,
        reason: '该切片不适用于智联',
      });
      await assert.rejects(
        () => loadTalentMappingPlanFile(disabledPath, { platformSelection: 'zhilian' }),
        /explicitly disables selected platform zhilian/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects enrichment references that are not declared by the deterministic taxonomy', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-taxonomy-'));
    try {
      const plan = basePlan();
      plan.enrichment.selection.targetCompanyTiers = ['UNKNOWN'];
      const filePath = await writePlanTree(tempDir, plan);
      await assert.rejects(
        () => loadTalentMappingPlanFile(filePath, { platformSelection: '51job' }),
        /unknown company tier/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

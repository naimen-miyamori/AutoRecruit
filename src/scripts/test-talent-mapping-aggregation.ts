import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTalentMappingDerivedViews } from '../talent-mapping/aggregation.js';
import { createMappingCandidateObservation } from '../talent-mapping/normalization.js';
import type { TalentMappingPlan } from '../types/talent-mapping.js';

const plan: TalentMappingPlan = {
  version: 1,
  mappingKey: 'mapping-test',
  name: '测试人才地图',
  objective: { roleFamilies: ['区域运营'], locations: ['上海'] },
  taxonomy: {
    targetCompanies: [{
      companyKey: 'sample-retail',
      displayName: '示例零售',
      aliases: ['示例零售（中国）有限公司'],
      tier: 'A',
    }],
    roleFamilies: [{
      roleKey: 'regional-operations',
      displayName: '区域运营',
      titleAliases: ['区域运营经理', '区域经理'],
    }],
    levels: ['经理', '高级经理'],
  },
  slices: [],
  coverage: { maxBatchesPerSlice: 2, maxCandidatesPerSlice: 20, sliceTimeoutMs: 60000 },
  enrichment: {
    mode: 'targeted-detail',
    maxProfilesPerSlice: 5,
    maxProfilesTotal: 5,
    selection: { targetCompanyTiers: ['A'], samplePerMatrixCell: 2 },
  },
};

describe('Talent Mapping deterministic aggregation', () => {
  it('normalizes explicit company aliases, longest role/level rules, and keeps platforms isolated', () => {
    const observedAt = '2026-07-28T01:00:00.000Z';
    const observations = [
      createMappingCandidateObservation({
        candidate: {
          candidateId: 'candidate-1',
          name: '候选人甲',
          currentCompany: '示例零售（中国）有限公司',
          currentTitle: '高级区域运营经理',
          cardText: '现居上海',
        },
        plan,
        runId: 'run-1',
        sliceId: 'slice-1',
        platform: '51job',
        observedAt,
        batchIdentity: 'batch-1',
        batchNumber: 1,
        rankInBatch: 1,
      }),
      createMappingCandidateObservation({
        candidate: {
          candidateId: 'candidate-1',
          name: '候选人乙',
          currentCompany: '示例零售（中国）有限公司',
          currentTitle: '区域经理',
          cardText: '上海',
        },
        plan,
        runId: 'run-1',
        sliceId: 'slice-1',
        platform: 'liepin',
        observedAt,
        batchIdentity: 'batch-1',
        batchNumber: 1,
        rankInBatch: 1,
      }),
    ];

    assert.equal(observations[0].normalized.companyKey, 'sample-retail');
    assert.equal(observations[0].normalized.roleKey, 'regional-operations');
    assert.equal(observations[0].normalized.level, '高级经理');
    assert.equal(observations[0].normalized.location, '上海');
    assert.notEqual(observations[0].platformCandidateKey, observations[1].platformCandidateKey);

    const views = buildTalentMappingDerivedViews({
      plan,
      observations,
      profileObservations: [],
      sliceRuns: [],
      generatedAt: observedAt,
    });
    assert.equal(views.candidates.length, 2);
    assert.equal(views.companies.length, 2);
    assert.deepStrictEqual(views.companies.map((row) => row.platform).sort(), ['51job', 'liepin']);
  });

  it('preserves unmatched raw values in an auditable unclassified matrix row', () => {
    const observation = createMappingCandidateObservation({
      candidate: {
        candidateId: 'candidate-2',
        currentCompany: '未配置公司',
        currentTitle: '特殊岗位',
        cardText: '地点未知',
      },
      plan,
      runId: 'run-1',
      sliceId: 'slice-1',
      platform: 'zhilian',
      observedAt: '2026-07-28T01:00:00.000Z',
      batchIdentity: 'batch-1',
      rankInBatch: 1,
    });
    assert.equal(observation.normalized.companyKey, undefined);
    assert.ok(observation.evidence.some((item) => item.field === 'company' && item.confidence === 'unclassified'));

    const views = buildTalentMappingDerivedViews({
      plan,
      observations: [observation],
      profileObservations: [],
      sliceRuns: [],
    });
    assert.equal(views.companies[0].companyKey, 'unclassified');
    assert.equal(views.companies[0].companyDisplayName, '未配置公司');
    assert.equal(views.companies[0].unclassifiedProfiles, 1);
  });
});

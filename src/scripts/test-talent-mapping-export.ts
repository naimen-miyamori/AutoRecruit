import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { exportTalentMapping } from '../talent-mapping/export.js';
import type { MappingDerivedViews, MappingRunRecord, TalentMappingPlan } from '../types/talent-mapping.js';

const generatedAt = '2026-07-28T03:00:00.000Z';
const plan: TalentMappingPlan = {
  version: 1,
  mappingKey: 'mapping-export',
  name: '脱敏人才地图',
  objective: { roleFamilies: ['运营'], locations: ['上海'] },
  taxonomy: {
    targetCompanies: [{ companyKey: 'sample', displayName: '示例公司', aliases: [], tier: 'A' }],
    roleFamilies: [{ roleKey: 'operations', displayName: '运营', titleAliases: ['运营经理'] }],
    levels: ['经理'],
  },
  slices: [],
  coverage: { maxBatchesPerSlice: 1, maxCandidatesPerSlice: 10, sliceTimeoutMs: 30000 },
  enrichment: { mode: 'card-only' },
};
const run: MappingRunRecord = {
  runId: 'run-export',
  mappingKey: plan.mappingKey,
  mappingName: plan.name,
  stage: 'scan',
  platformSelection: 'all',
  status: 'completed-with-gaps',
  detailOpenConfirmed: false,
  detailOpenSideEffect: 'none',
  startedAt: generatedAt,
  finishedAt: generatedAt,
  sliceRuns: [],
};
const views: MappingDerivedViews = {
  generatedAt,
  candidates: [{
    platform: '51job',
    platformCandidateKey: '51job:candidate-1',
    candidateId: 'candidate-1',
    name: '候选人,甲',
    currentCompany: '示例公司',
    currentTitle: '运营经理',
    companyKey: 'sample',
    roleKey: 'operations',
    level: '经理',
    location: '上海',
    firstObservedAt: generatedAt,
    lastObservedAt: generatedAt,
    sourceSliceIds: ['slice-1'],
    observationCount: 1,
    detailStatus: 'not-enriched',
  }],
  companies: [{
    companyKey: 'sample',
    companyDisplayName: '示例公司',
    companyTier: 'A',
    roleKey: 'operations',
    roleDisplayName: '运营',
    level: '经理',
    location: '上海',
    platform: '51job',
    platformProfiles: 1,
    enrichedProfiles: 0,
    unclassifiedProfiles: 0,
  }],
  coverage: [{
    runId: 'run-export',
    mappingKey: plan.mappingKey,
    sliceId: 'slice-1',
    platform: '51job',
    status: 'completed-with-gaps',
    reportedResultTotal: 100,
    reportedResultTotalSource: 'page',
    scannedBatches: 1,
    observedCards: 10,
    uniquePlatformProfiles: 10,
    eligibleForDetail: 0,
    enrichedProfiles: 0,
    failedProfiles: [],
    terminationReason: 'batch-limit',
    startedAt: generatedAt,
    finishedAt: generatedAt,
    cardCoverage: 0.1,
    cardCoverageStatus: 'known',
    detailCoverageStatus: 'zero-eligible',
    coverageStatus: 'capped',
  }],
};

describe('Talent Mapping exports', () => {
  it('writes CSV and Markdown with platform identity, coverage semantics, and no cross-platform auto-dedup claim', async () => {
    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-export-'));
    try {
      const result = await exportTalentMapping({ plan, run, views, exportDir, generatedAt });
      const [candidates, matrix, coverage, summary] = await Promise.all([
        fs.readFile(result.candidatesCsvPath, 'utf8'),
        fs.readFile(result.companyRoleMatrixCsvPath, 'utf8'),
        fs.readFile(result.coverageCsvPath, 'utf8'),
        fs.readFile(result.summaryPath, 'utf8'),
      ]);
      assert.match(candidates, /platform,candidate_id/);
      assert.match(candidates, /51job/);
      assert.match(candidates, /"候选人,甲"/);
      assert.match(matrix, /platform_profiles/);
      assert.match(coverage, /batch-limit/);
      assert.match(summary, /市场扫描 \/ Mapping 初筛/);
      assert.match(summary, /跨平台.*不会自动合并/);
      assert.match(summary, /已查看.*副作用/);
      assert.doesNotMatch(summary, /完整原始简历/);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });
});

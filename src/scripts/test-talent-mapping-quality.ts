import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildMappingRunChangeReport } from '../talent-mapping/change-report.js';
import { countConfirmedMappingEntities } from '../talent-mapping/entity-links.js';
import { createMappingCandidateObservation } from '../talent-mapping/normalization.js';
import { loadTalentMappingPlanFile } from '../talent-mapping/plan.js';
import { TalentMappingQualityService } from '../talent-mapping/quality-service.js';
import { buildMappingRunContract } from '../talent-mapping/run-contract.js';
import { TalentMappingStore } from '../talent-mapping/store.js';
import { runTalentMappingClassificationTask } from '../server/talent-mapping-classification-runner.js';
import type {
  MappingCandidateObservation,
  MappingRunRecord,
  TalentMappingCorePlatform,
  TalentMappingPlan,
} from '../types/talent-mapping.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/talent-mapping/retail-operations.example.json', import.meta.url));

function runRecord(plan: TalentMappingPlan, runId: string, startedAt: string): MappingRunRecord {
  const contract = buildMappingRunContract({
    plan,
    runId,
    platformSelection: 'all',
    capturedAt: startedAt,
  });
  return {
    runId,
    mappingKey: plan.mappingKey,
    mappingName: plan.name,
    stage: 'scan',
    platformSelection: 'all',
    planHash: contract.planHash,
    scanContractHash: contract.scanContractHash,
    scopeFingerprint: contract.scopeFingerprint,
    contractStatus: 'verified',
    planSnapshotPath: `runs/contracts/${runId}.json`,
    status: 'completed',
    detailOpenConfirmed: false,
    detailOpenSideEffect: 'none',
    startedAt,
    finishedAt: startedAt,
    sliceRuns: [],
  };
}

function observation(input: {
  plan: TalentMappingPlan;
  runId: string;
  platform: TalentMappingCorePlatform;
  candidateId: string;
  observedAt: string;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  cardText?: string;
}): MappingCandidateObservation {
  return createMappingCandidateObservation({
    candidate: {
      candidateId: input.candidateId,
      name: input.name,
      currentCompany: input.currentCompany,
      currentTitle: input.currentTitle,
      cardText: input.cardText,
    },
    plan: input.plan,
    runId: input.runId,
    sliceId: input.plan.slices[0]!.sliceId,
    platform: input.platform,
    observedAt: input.observedAt,
    batchIdentity: `${input.runId}-batch`,
    rankInBatch: 1,
  });
}

describe('Talent Mapping M4 quality loops', () => {
  it('reports new, changed, and not-observed profiles using run-scoped page evidence', async () => {
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
    const firstAt = '2026-07-28T01:00:00.000Z';
    const secondAt = '2026-07-29T01:00:00.000Z';
    const observations = [
      observation({ plan, runId: 'run-1', platform: '51job', candidateId: 'changed', observedAt: firstAt, name: '候选人甲', currentCompany: '示例零售（中国）有限公司', currentTitle: '区域经理', cardText: '上海' }),
      observation({ plan, runId: 'run-2', platform: '51job', candidateId: 'changed', observedAt: secondAt, name: '候选人甲', currentCompany: '示例零售（中国）有限公司', currentTitle: '大区经理', cardText: '上海' }),
      observation({ plan, runId: 'run-1', platform: 'liepin', candidateId: 'missing', observedAt: firstAt, name: '候选人乙' }),
      observation({ plan, runId: 'run-2', platform: 'zhilian', candidateId: 'new', observedAt: secondAt, name: '候选人丙' }),
    ];
    const report = buildMappingRunChangeReport({
      mappingKey: plan.mappingKey,
      runs: [runRecord(plan, 'run-1', firstAt), runRecord(plan, 'run-2', secondAt)],
      observations,
      generatedAt: secondAt,
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.newProfiles[0]?.platformCandidateKey, 'zhilian:new');
    assert.equal(report.notObservedProfiles[0]?.platformCandidateKey, 'liepin:missing');
    assert.deepStrictEqual(report.changedProfiles[0]?.fields.map((field) => field.field), ['currentTitle']);
    assert.ok(report.changedProfiles[0]?.fields[0]?.currentEvidence.length);
    assert.match(report.caveat, /不能解释为离职/);
  });

  it('disables not-observed conclusions for partial or incomparable runs', async () => {
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
    const firstAt = '2026-07-28T01:00:00.000Z';
    const secondAt = '2026-07-29T01:00:00.000Z';
    const observations = [
      observation({ plan, runId: 'run-1', platform: '51job', candidateId: 'missing', observedAt: firstAt, name: '候选人甲' }),
      observation({ plan, runId: 'run-2', platform: '51job', candidateId: 'new', observedAt: secondAt, name: '候选人乙' }),
    ];
    const partialBase = { ...runRecord(plan, 'run-1', firstAt), status: 'completed-with-gaps' as const };
    const compare = runRecord(plan, 'run-2', secondAt);
    const partial = buildMappingRunChangeReport({
      mappingKey: plan.mappingKey,
      runs: [partialBase, compare],
      observations,
      generatedAt: secondAt,
    });
    assert.equal(partial.status, 'partial');
    assert.equal(partial.notObservedProfiles.length, 0);
    assert.equal(partial.newProfiles[0]?.platformCandidateKey, '51job:new');

    const incompatible = buildMappingRunChangeReport({
      mappingKey: plan.mappingKey,
      runs: [runRecord(plan, 'run-1', firstAt), { ...compare, scanContractHash: 'different-contract' }],
      observations,
      generatedAt: secondAt,
    });
    assert.equal(incompatible.status, 'incomparable');
    assert.equal(incompatible.notObservedProfiles.length, 0);
    assert.match(incompatible.comparisonReasons.join('\n'), /合同哈希不同/);
  });

  it('keeps cross-platform link suggestions non-authoritative until explicit confirmation and preserves revocation audit', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-links-'));
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
    const store = new TalentMappingStore({ dataDir, now: () => new Date('2026-07-28T02:00:00.000Z') });
    const service = new TalentMappingQualityService({ store, now: () => new Date('2026-07-28T03:00:00.000Z') });
    try {
      await store.saveProject(plan, fixturePath);
      for (const platform of ['51job', 'liepin'] as const) {
        await store.appendCandidateObservation(observation({
          plan,
          runId: 'run-1',
          platform,
          candidateId: `${platform}-candidate`,
          observedAt: '2026-07-28T02:00:00.000Z',
          name: '候选人甲',
          currentCompany: '示例零售（中国）有限公司',
          currentTitle: '区域经理',
          cardText: '上海',
        }));
      }
      await store.saveRun(runRecord(plan, 'run-1', '2026-07-28T02:00:00.000Z'));
      await store.rebuildDerivedViews(plan.mappingKey);

      const before = await service.getEntityLinkReview(plan.mappingKey);
      assert.equal(before.suggestions.length, 1);
      assert.equal(before.activeLinks.length, 0);
      assert.equal(before.confirmedEntityCount, 2);
      const [link, retriedLink] = await Promise.all([
        service.confirmEntityLink(plan.mappingKey, {
          platformCandidateKeys: before.suggestions[0]!.platformCandidateKeys,
          confirmedBy: '审核员甲',
          evidence: '人工核对公司、岗位及履历后确认',
        }),
        service.confirmEntityLink(plan.mappingKey, {
          platformCandidateKeys: before.suggestions[0]!.platformCandidateKeys,
          confirmedBy: '审核员甲',
          evidence: '人工核对公司、岗位及履历后确认',
        }),
      ]);
      assert.equal(link.entityId, retriedLink.entityId);
      const confirmed = await service.getEntityLinkReview(plan.mappingKey);
      assert.equal(confirmed.activeLinks.length, 1);
      assert.equal(confirmed.confirmedEntityCount, 1);
      assert.equal(countConfirmedMappingEntities(2, confirmed.activeLinks), 1);
      assert.equal((await store.readCandidateView(plan.mappingKey)).every((candidate) => candidate.entityId === link.entityId), true);

      await service.revokeEntityLink(plan.mappingKey, link.entityId, {
        revokedBy: '审核员乙',
        reason: '后续证据确认并非同一人',
      });
      const revoked = await service.getEntityLinkReview(plan.mappingKey);
      assert.equal(revoked.activeLinks.length, 0);
      assert.equal(revoked.revokedLinks.length, 1);
      assert.equal(revoked.confirmedEntityCount, 2);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('sends only bounded company/title/location fields to the model and applies a suggestion only after human acceptance', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-classification-'));
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
    const store = new TalentMappingStore({ dataDir, now: () => new Date('2026-07-28T04:00:00.000Z') });
    let modelInput = '';
    try {
      await store.saveProject(plan, fixturePath);
      await store.appendCandidateObservation(observation({
        plan,
        runId: 'run-1',
        platform: '51job',
        candidateId: 'sensitive-id-1',
        observedAt: '2026-07-28T04:00:00.000Z',
        name: '候选人敏感姓名',
        currentCompany: '示例零售A集团',
        currentTitle: '区域营运主管',
        cardText: '上海 私人卡片全文不得进入模型',
      }));
      await store.saveRun(runRecord(plan, 'run-1', '2026-07-28T04:00:00.000Z'));
      await store.rebuildDerivedViews(plan.mappingKey);
      const output = await runTalentMappingClassificationTask({ mappingKey: plan.mappingKey }, {
        store,
        model: 'test-classifier',
        now: () => new Date('2026-07-28T05:00:00.000Z'),
        completeJsonText: async (request) => {
          modelInput = request.input;
          return JSON.stringify({ suggestions: [{
            ref: 'item-1',
            companyKey: 'sample-retail-a',
            roleKey: 'regional-operations',
            level: '经理',
            location: '上海',
            rationale: '公司和职位文本与显式 taxonomy 相符',
            evidenceFields: ['currentCompany', 'currentTitle', 'location'],
          }] });
        },
      });
      assert.equal(output.generatedSuggestions, 1);
      assert.doesNotMatch(modelInput, /候选人敏感姓名|sensitive-id-1|私人卡片全文/);
      assert.match(modelInput, /示例零售A集团|区域营运主管|上海/);

      const beforeReview = await store.readCandidateView(plan.mappingKey);
      assert.equal(beforeReview[0]?.companyKey, undefined);
      const service = new TalentMappingQualityService({ store, now: () => new Date('2026-07-28T06:00:00.000Z') });
      const suggestions = await service.listClassificationSuggestions(plan.mappingKey);
      const sourceSuggestion = suggestions[0]!;
      await store.appendClassificationSuggestion({
        ...sourceSuggestion,
        suggestionId: 'tampered-evidence-suggestion',
        evidence: sourceSuggestion.evidence.map((item, index) =>
          index === 0 ? { ...item, rawValue: '伪造证据' } : item),
      });
      await assert.rejects(
        () => service.reviewClassificationSuggestion(plan.mappingKey, 'tampered-evidence-suggestion', {
          decision: 'accepted',
          reviewedBy: '分类审核员',
        }),
        /evidence value does not match its source observation/,
      );
      const acceptedReviews = await Promise.all([
        service.reviewClassificationSuggestion(plan.mappingKey, suggestions[0]!.suggestionId, {
          decision: 'accepted',
          reviewedBy: '分类审核员',
          note: '页面字段支持该归类',
        }),
        service.reviewClassificationSuggestion(plan.mappingKey, suggestions[0]!.suggestionId, {
          decision: 'accepted',
          reviewedBy: '分类审核员',
          note: '页面字段支持该归类',
        }),
      ]);
      assert.equal(acceptedReviews[0]!.reviewId, acceptedReviews[1]!.reviewId);
      const afterReview = await store.readCandidateView(plan.mappingKey);
      assert.equal(afterReview[0]?.companyKey, 'sample-retail-a');
      assert.equal(afterReview[0]?.roleKey, 'regional-operations');
      assert.equal(afterReview[0]?.manualClassification?.reviewedBy, '分类审核员');
      assert.equal((await service.listClassificationSuggestions(plan.mappingKey))[0]?.review?.decision, 'accepted');

      const replacementSuggestion = {
        ...suggestions[0]!,
        suggestionId: 'replacement-classification-suggestion',
        proposed: { ...suggestions[0]!.proposed, level: '高级经理' },
        createdAt: '2026-07-28T06:30:00.000Z',
      };
      await store.appendClassificationSuggestion(replacementSuggestion);
      await assert.rejects(
        () => service.reviewClassificationSuggestion(plan.mappingKey, replacementSuggestion.suggestionId, {
          decision: 'accepted',
          reviewedBy: '分类审核员乙',
        }),
        /already have an accepted review/,
      );
      const replacementReview = await service.reviewClassificationSuggestion(plan.mappingKey, replacementSuggestion.suggestionId, {
        decision: 'accepted',
        reviewedBy: '分类审核员乙',
        note: '更正职级判断',
        supersedeReviewId: acceptedReviews[0]!.reviewId,
      });
      assert.equal((await store.readCandidateView(plan.mappingKey))[0]?.level, '高级经理');
      assert.equal(replacementReview.supersedesReviewId, acceptedReviews[0]!.reviewId);

      const revokedReview = await service.revokeClassificationSuggestion(plan.mappingKey, replacementSuggestion.suggestionId, {
        reviewedBy: '分类审核员丙',
        reason: '后续页面证据不足，撤销人工分类',
      });
      assert.equal(revokedReview.decision, 'revoked');
      assert.equal(revokedReview.supersedesReviewId, acceptedReviews[0]!.reviewId);
      assert.equal((await store.readCandidateView(plan.mappingKey))[0]?.companyKey, undefined);
      assert.equal((await service.listClassificationSuggestions(plan.mappingKey))
        .find((suggestion) => suggestion.suggestionId === replacementSuggestion.suggestionId)?.review?.decision, 'revoked');
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

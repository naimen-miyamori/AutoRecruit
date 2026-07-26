import type { Page } from 'playwright';
import type {
  BossGreetInput,
  BossGreetResult,
  BossTalentSearchInput,
  BossTalentSearchResult,
} from '../types/boss.js';
import {
  greetBossTalentCandidateAction,
  openBossTalentPage,
  readBossDeepSearchCandidates,
  readBossDeepSearchForm,
  readBossRecommendationCandidates,
  synchronizeBossDeepSearchRequirements,
  triggerBossDeepSearchMatch,
} from './boss/actions/talent-actions.js';

export {
  openBossTalentPage,
  readBossDeepSearchCandidates,
  readBossDeepSearchForm,
  readBossRecommendationCandidates,
  synchronizeBossDeepSearchRequirements,
  triggerBossDeepSearchMatch,
} from './boss/actions/talent-actions.js';

export async function greetBossTalentCandidate(page: Page, input: BossGreetInput): Promise<BossGreetResult> {
  if (!input.confirmed) {
    throw new Error('Boss candidate greet requires confirmed=true.');
  }
  if (!input.candidateId.trim() || !input.expectedCandidateName.trim() || !input.expectedJobName.trim()) {
    throw new Error('Boss candidate greet requires candidateId, expectedCandidateName, and expectedJobName.');
  }
  if (input.source === 'normal-search') {
    throw new Error('Single-candidate greet currently supports Boss recommendation and deep-search results only.');
  }
  return greetBossTalentCandidateAction(page, {
    source: input.source,
    candidateId: input.candidateId,
    expectedCandidateName: input.expectedCandidateName,
    expectedJobName: input.expectedJobName,
    bossJobId: input.bossJobId,
    intentId: input.intentId,
  });
}

export async function runBossTalentSearch(page: Page, input: BossTalentSearchInput): Promise<BossTalentSearchResult> {
  if (input.triggerMatch === true && input.confirmed !== true) {
    throw new Error('Boss deep-search immediate match requires confirmed=true.');
  }
  await openBossTalentPage(page, input.source);
  if (input.source === 'recommend') {
    return {
      platform: 'boss',
      source: 'recommend',
      matched: false,
      candidates: await readBossRecommendationCandidates(page),
    };
  }

  let form = await readBossDeepSearchForm(page);
  if (input.expectedJobName && form.jobName && input.expectedJobName !== form.jobName) {
    throw new Error(`Boss deep-search selected job mismatch: expected ${input.expectedJobName}, found ${form.jobName}.`);
  }
  if (input.bossJobId && form.bossJobId && input.bossJobId !== form.bossJobId) {
    throw new Error(`Boss deep-search selected job ID mismatch: expected ${input.bossJobId}, found ${form.bossJobId}.`);
  }
  if (input.coreRequirements) {
    form = await synchronizeBossDeepSearchRequirements(page, {
      coreRequirements: input.coreRequirements,
      bonusRequirements: input.bonusRequirements,
    });
  }
  const candidates = input.triggerMatch === true
    ? await triggerBossDeepSearchMatch(page)
    : await readBossDeepSearchCandidates(page);
  return {
    platform: 'boss',
    source: 'deep-search',
    form,
    matched: input.triggerMatch === true,
    candidates,
  };
}

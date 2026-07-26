import type { Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import { parseBossResumeDataPayload } from '../parsing/resume-parser.js';
import { clickBossControlNatively, runBossAction } from './context.js';
import { isBossChatPage } from './navigation-actions.js';
import {
  closeExistingBossResumeDialog,
  parseBossResumeDetail,
  waitForBossResumeDetailReady,
} from './resume-detail-actions.js';

export interface BossChatResumeSource {
  candidate: CandidateListItem;
  resume: CandidateResume;
}

export function parseBossResumeData(
  geekDetail: Record<string, unknown>,
  page: Page,
  candidate: CandidateListItem,
): CandidateResume {
  return parseBossResumeDataPayload(geekDetail, page.url(), candidate);
}

function mergeBossChatResume(summary: CandidateResume, detail: CandidateResume): CandidateResume {
  const detailHasRichWork = detail.workExperiences.length > summary.workExperiences.length
    || detail.workExperiences.some((work) => work.details.length > 0);
  const detailHasRichEducation = detail.educationExperiences.length > summary.educationExperiences.length
    || detail.educationExperiences.some((education) => education.details.length > 0);
  return {
    ...summary,
    name: detail.name ?? summary.name,
    age: detail.age ?? summary.age,
    nativePlace: detail.nativePlace ?? summary.nativePlace,
    education: detail.education ?? summary.education,
    regions: detail.regions.length > 0 ? detail.regions : summary.regions,
    pr: detail.pr.length > 0 ? detail.pr : summary.pr,
    workExperiences: detailHasRichWork ? detail.workExperiences : summary.workExperiences,
    projectExperiences: detail.projectExperiences.length > 0 ? detail.projectExperiences : summary.projectExperiences,
    educationExperiences: detailHasRichEducation ? detail.educationExperiences : summary.educationExperiences,
    skill: detail.skill.length > 0 ? detail.skill : summary.skill,
    certificates: detail.certificates.length > 0 ? detail.certificates : summary.certificates,
  };
}

export async function openAndParseBossChatResume(
  page: Page,
  opened: BossChatResumeSource,
): Promise<CandidateResume> {
  const deadline = Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
  await closeExistingBossResumeDialog(page, deadline);
  const abstractMessageCount = await page.evaluate(() => {
    type BossResumeCaptureWindow = Window & typeof globalThis & {
      __autorecruitBossResumeAbstracts?: unknown[];
      __autorecruitBossResumeListenerInstalled?: boolean;
    };
    const target = window as BossResumeCaptureWindow;
    target.__autorecruitBossResumeAbstracts ??= [];
    if (!target.__autorecruitBossResumeListenerInstalled) {
      target.__autorecruitBossResumeListenerInstalled = true;
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'IFRAME_DONE' && event.data?.data?.abstractData) {
          target.__autorecruitBossResumeAbstracts!.push(event.data.data.abstractData);
        }
      });
    }

    return target.__autorecruitBossResumeAbstracts.length;
  });
  const primaryResumeButton = page.locator('.chat-conversation .resume-btn-online');
  const primaryCount = await primaryResumeButton.count();
  const onlineResume = primaryCount === 1
    ? primaryResumeButton
    : page.getByText('简历简介', { exact: true }).or(page.getByText('在线简历', { exact: true }));
  const onlineResumeCount = await onlineResume.count();
  if (onlineResumeCount !== 1) {
    throw new Error(`Expected one Boss chat resume introduction control, found ${onlineResumeCount}.`);
  }

  await runBossAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await clickBossControlNatively(page, onlineResume, config.playwright.resumeDetailTimeoutMs);
  if (!isBossChatPage(page.url())) {
    throw new Error(`Boss resume introduction click left the chat page unexpectedly: ${page.url()}`);
  }
  await waitForBossResumeDetailReady(page, deadline);
  await runBossAction(page, async () => undefined);
  const parseDeadline = Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);

  const abstractData = await page.waitForFunction((previousCount) => {
    const values = (window as Window & typeof globalThis & {
      __autorecruitBossResumeAbstracts?: unknown[];
    }).__autorecruitBossResumeAbstracts ?? [];
    return values.length > previousCount ? values.at(-1) : undefined;
  }, abstractMessageCount, { timeout: Math.max(parseDeadline - Date.now(), 1), polling: 100 })
    .then((handle) => handle.jsonValue() as Promise<Record<string, unknown>>)
    .catch(() => undefined);
  const abstractResume = abstractData
    ? parseBossResumeData(abstractData, page, opened.candidate)
    : undefined;
  const apiResume = await parseBossResumeDetail(page, opened.candidate).catch(() => undefined);
  const withAbstract = abstractResume ? mergeBossChatResume(opened.resume, abstractResume) : opened.resume;
  return apiResume ? mergeBossChatResume(withAbstract, apiResume) : withAbstract;
}

export async function closeBossChatResume(page: Page): Promise<void> {
  const deadline = Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
  await closeExistingBossResumeDialog(page, deadline);
}

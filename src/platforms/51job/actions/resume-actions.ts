import { openResumeDetail, parseResumeDetail } from '../../../browser/resume-detail.js';
import { waitPlatformActionPace } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { CandidateProfileDetailResult } from '../../../types/talent-mapping.js';
import type { CandidateProfileDetailOptions, PlatformAdapter } from '../../types.js';
import { registerTemporaryRuntimePageForContext } from '../../../browser/runtime-page-registry.js';

function remainingDetailMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('51job candidate profile detail deadline exhausted');
  }
  return remaining;
}

async function withinDetailDeadline<T>(deadline: number, operation: Promise<T>): Promise<T> {
  const timeoutMs = remainingDetailMs(deadline);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('51job candidate profile detail deadline exhausted')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function open51jobResumeDetail(
  ...args: Parameters<PlatformAdapter['openResumeDetail']>
): Promise<Awaited<ReturnType<PlatformAdapter['openResumeDetail']>>> {
  const detailPage = await openResumeDetail(...args);
  const [context, searchPage, candidate] = args;
  if (detailPage !== searchPage) {
    registerTemporaryRuntimePageForContext(context, detailPage, {
      purpose: 'candidate-detail',
      identity: candidate.candidateId,
      cleanupPolicy: 'close',
    });
  }
  return detailPage;
}

export async function parse51jobResumeDetail(
  ...args: Parameters<PlatformAdapter['parseResumeDetail']>
): Promise<Awaited<ReturnType<PlatformAdapter['parseResumeDetail']>>> {
  const [page, candidate] = args;
  return (await parseResumeDetail(page, candidate)).resume;
}

export async function read51jobCandidateProfileDetail(
  context: Parameters<PlatformAdapter['openResumeDetail']>[0],
  searchPage: Parameters<PlatformAdapter['openResumeDetail']>[1],
  candidate: Parameters<PlatformAdapter['openResumeDetail']>[2],
  options: CandidateProfileDetailOptions,
): Promise<CandidateProfileDetailResult> {
  const detailPage = await open51jobResumeDetail(context, searchPage, candidate, options);
  if (remainingDetailMs(options.deadline) <= config.playwright.actionDelayMaxMsByPlatform['51job']) {
    throw new Error('51job candidate profile detail deadline cannot accommodate the required post-open pacing interval');
  }
  await waitPlatformActionPace(detailPage, '51job');
  const extraction = await withinDetailDeadline(options.deadline, parseResumeDetail(detailPage, candidate));
  if (extraction.resume.candidateId !== candidate.candidateId) {
    throw new Error(`51job candidate profile identity mismatch: expected ${candidate.candidateId}, got ${extraction.resume.candidateId}`);
  }
  const rawText = await withinDetailDeadline(
    options.deadline,
    detailPage.locator('body').innerText(),
  ).catch(() => undefined);
  return {
    resume: extraction.resume,
    rawText,
    detailPage,
  };
}

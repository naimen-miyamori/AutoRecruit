import { openResumeDetail, parseResumeDetail } from '../../../browser/resume-detail.js';
import type { PlatformAdapter } from '../../types.js';

export async function open51jobResumeDetail(
  ...args: Parameters<PlatformAdapter['openResumeDetail']>
): Promise<Awaited<ReturnType<PlatformAdapter['openResumeDetail']>>> {
  return openResumeDetail(...args);
}

export async function parse51jobResumeDetail(
  ...args: Parameters<PlatformAdapter['parseResumeDetail']>
): Promise<Awaited<ReturnType<PlatformAdapter['parseResumeDetail']>>> {
  const [page, candidate] = args;
  return (await parseResumeDetail(page, candidate)).resume;
}

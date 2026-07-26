import { collectCandidateList } from '../../../browser/candidate-list.js';
import type { PlatformAdapter } from '../../types.js';

export async function extract51jobCandidateList(
  ...args: Parameters<PlatformAdapter['extractCandidateList']>
): Promise<Awaited<ReturnType<PlatformAdapter['extractCandidateList']>>> {
  const [page, options] = args;
  return { candidates: await collectCandidateList(page, options) };
}

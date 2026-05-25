import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { getResumeDomSnapshot, collectResumePageEvidence, waitForResumeDetailContentRef } from '../browser/resume-detail.js';
import { JobStore } from '../storage/job-store.js';
import { getPlatformAdapter, parsePlatformArg } from '../platforms/registry.js';
import { isSafeLiepinResumeUrl } from '../platforms/liepin-adapter.js';
import type { SupportedPlatform } from '../platforms/types.js';

interface CaptureInput {
  platform: SupportedPlatform;
  jobKey: string;
  searchKeyword?: string;
  candidateId: string;
  resumeUrl?: string;
}

function parseArgs(argv: string[]): CaptureInput {
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--platform') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for argument --platform');
      }
      values.set('platform', value);
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  const platform = parsePlatformArg(values.get('platform'));
  const [jobKey, second, third] = positional;

  if (!jobKey || !second) {
    throw new Error('Usage: tsx src/scripts/capture-resume-dom-snapshot.ts [--platform <platform>] <jobKey> <searchKeyword> <candidateId> | <jobKey> <candidateId> <resumeUrl>');
  }

  if (third && /^https?:\/\//.test(third)) {
    return {
      platform,
      jobKey,
      candidateId: second,
      resumeUrl: third,
    };
  }

  if (!third) {
    throw new Error('Usage: tsx src/scripts/capture-resume-dom-snapshot.ts [--platform <platform>] <jobKey> <searchKeyword> <candidateId> | <jobKey> <candidateId> <resumeUrl>');
  }

  return {
    platform,
    jobKey,
    searchKeyword: second,
    candidateId: third,
  };
}

export async function openResumeByUrl(session: Awaited<ReturnType<typeof ensureAuthenticatedBrowserSession>>, resumeUrl: string, candidateId: string) {
  await session.page.goto(resumeUrl, { waitUntil: 'domcontentloaded' });

  const bodyText = await waitForResumeDetailContentRef.fn(session.page, candidateId);
  if (!bodyText.includes(candidateId)) {
    throw new Error(`Resume detail did not load for candidate ${candidateId}`);
  }

  return session.page;
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  if (input.platform === 'liepin' && input.resumeUrl && !isSafeLiepinResumeUrl(input.resumeUrl)) {
    throw new Error(`Refusing to open unsupported Liepin resume URL: ${input.resumeUrl}`);
  }
  const session = await ensureAuthenticatedBrowserSession(input.platform);
  const store = new JobStore();
  const platformAdapter = getPlatformAdapter(input.platform);

  try {
    await store.initializeJob(input.platform, input.jobKey);
    const detailPage = input.resumeUrl
      ? await openResumeByUrl(session, input.resumeUrl, input.candidateId)
      : await (async () => {
        const searchPage = await platformAdapter.openSubscribeSearch(session.page, input.searchKeyword!);
        const { candidates } = await platformAdapter.extractCandidateList(searchPage);
        const candidate = candidates.find((item) => item.candidateId === input.candidateId);

        if (!candidate) {
          throw new Error(`Candidate ${input.candidateId} not found in search results for ${input.searchKeyword}`);
        }

        return platformAdapter.openResumeDetail(session.context, searchPage, candidate);
      })();

    const pageEvidence = await collectResumePageEvidence(detailPage);
    const domSnapshot = await getResumeDomSnapshot(detailPage);

    if (!domSnapshot) {
      console.log(JSON.stringify({
        jobKey: input.jobKey,
        searchKeyword: input.searchKeyword,
        candidateId: input.candidateId,
        pageEvidence,
        domSnapshot: null,
      }, null, 2));
      throw new Error(`No DOM snapshot extracted for candidate ${input.candidateId}`);
    }

    const domSnapshotPath = path.join(config.dataDir, input.platform, 'jobs', input.jobKey, 'snapshots-dom', `${input.candidateId}.json`);
    await fs.writeFile(domSnapshotPath, `${JSON.stringify(domSnapshot, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
      jobKey: input.jobKey,
      searchKeyword: input.searchKeyword,
      candidateId: input.candidateId,
      resumeUrl: detailPage.url(),
      pageEvidence,
      domSnapshotPath,
      workLines: domSnapshot.workLines.length,
      workBlocks: domSnapshot.workBlocks?.length ?? 0,
      workNodes: domSnapshot.workNodes?.length ?? 0,
    }, null, 2));

    if (detailPage !== session.page) {
      await detailPage.close();
    }
  } finally {
    await closeBrowserSession(session);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

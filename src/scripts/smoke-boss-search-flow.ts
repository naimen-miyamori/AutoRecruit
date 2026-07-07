import { pathToFileURL } from 'node:url';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { getPlatformAdapter } from '../platforms/registry.js';

function parseKeyword(argv: string[]): string {
  const keywordIndex = argv.indexOf('--keyword');
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;

  return keyword && !keyword.startsWith('--') ? keyword : '';
}

function hasArg(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export async function runBossSearchSmokeFlow(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseKeyword(argv);
  const openFirst = hasArg(argv, '--open-first');
  const parseFirst = hasArg(argv, '--parse-first');
  const adapter = getPlatformAdapter('boss');
  const session = await ensureAuthenticatedBrowserSession('boss');

  try {
    const page = await adapter.openSubscribeSearch(session.page, keyword);
    const frame = page.frames().find((candidate) => /\/web\/frame\/search\//.test(candidate.url()))
      ?? page.frame({ name: 'searchFrame' });
    const selectedJob = frame
      ? await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().innerText().catch(() => '')
      : '';
    const { candidates } = await adapter.extractCandidateList(page);
    const openedDetail = openFirst || parseFirst
      ? await (async () => {
        const firstCandidate = candidates[0];
        if (!firstCandidate) {
          throw new Error('Boss smoke requested detail parsing/opening, but no candidate cards are visible.');
        }

        const detailPage = await adapter.openResumeDetail(session.context, page, firstCandidate);
        const parsedResume = parseFirst ? await adapter.parseResumeDetail(detailPage, firstCandidate) : undefined;
        const detailFrame = detailPage.frames().find((candidate) => /\/web\/frame\/c-resume\//.test(candidate.url()));
        const detailCanvas = detailFrame
          ? await detailFrame.locator('canvas#resume, #resume canvas').first().evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return {
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }).catch(() => undefined)
          : undefined;
        const dialogPreview = await detailPage.locator('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"])')
          .first()
          .innerText({ timeout: 3000 })
          .catch(() => '');

        return {
          candidateId: firstCandidate.candidateId,
          detailPageUrl: detailPage.url(),
          detailFrameUrl: detailFrame?.url() ?? '',
          detailCanvas,
          dialogPreview: dialogPreview.replace(/\s+/g, ' ').trim().slice(0, 240),
          parsedResume: parsedResume
            ? {
              candidateId: parsedResume.candidateId,
              name: parsedResume.name,
              age: parsedResume.age,
              education: parsedResume.education,
              regions: parsedResume.regions,
              workExperienceCount: parsedResume.workExperiences.length,
              projectExperienceCount: parsedResume.projectExperiences.length,
              educationExperienceCount: parsedResume.educationExperiences.length,
              certificateCount: parsedResume.certificates.length,
              firstWorkExperience: parsedResume.workExperiences[0],
              firstEducationExperience: parsedResume.educationExperiences[0],
            }
            : undefined,
        };
      })()
      : undefined;

    console.log(JSON.stringify({
      platform: adapter.platform,
      keyword,
      url: page.url(),
      frameUrl: frame?.url() ?? '',
      selectedJob: selectedJob.replace(/\s+/g, ' ').trim(),
      totalCandidates: candidates.length,
      sampleCandidates: candidates.slice(0, 5).map((candidate) => ({
        candidateId: candidate.candidateId,
        name: candidate.name,
        currentTitle: candidate.currentTitle,
        currentCompany: candidate.currentCompany,
        resumeUrl: candidate.resumeUrl,
        cardPreview: candidate.cardText?.replace(/\s+/g, ' ').trim().slice(0, 160),
      })),
      openedDetail,
      browserKeptOpen: session.keepOpenOnExit === true,
    }, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

async function main(): Promise<void> {
  await runBossSearchSmokeFlow(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

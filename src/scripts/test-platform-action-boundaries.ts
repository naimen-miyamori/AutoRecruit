import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface MigratedPlatformBoundary {
  platform: string;
  facadeFiles: string[];
  actionDirectory: string;
  parsingDirectory?: string;
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migratedPlatforms: MigratedPlatformBoundary[] = [
  {
    platform: '51job',
    facadeFiles: ['platforms/51job-adapter.ts'],
    actionDirectory: 'platforms/51job/actions',
    parsingDirectory: 'platforms/51job/parsing',
  },
  {
    platform: 'zhilian',
    facadeFiles: ['platforms/zhilian-adapter.ts'],
    actionDirectory: 'platforms/zhilian/actions',
    parsingDirectory: 'platforms/zhilian/parsing',
  },
  {
    platform: 'liepin',
    facadeFiles: ['platforms/liepin-adapter.ts'],
    actionDirectory: 'platforms/liepin/actions',
    parsingDirectory: 'platforms/liepin/parsing',
  },
  {
    platform: 'boss',
    facadeFiles: [
      'platforms/boss-adapter.ts',
      'platforms/boss-chat.ts',
      'platforms/boss-operations.ts',
      'platforms/boss-talent.ts',
      'platforms/boss-jobs.ts',
    ],
    actionDirectory: 'platforms/boss/actions',
    parsingDirectory: 'platforms/boss/parsing',
  },
];

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(sourceRoot, relativePath), 'utf8');
}

async function listTypeScriptFiles(relativeDirectory: string): Promise<string[]> {
  const absoluteDirectory = path.join(sourceRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(relativeDirectory, entry.name));
}

describe('migrated platform action boundaries', () => {
  it('keeps user-visible browser controls out of platform facades', async () => {
    const forbidden = [
      /clickPlatformLocator/,
      /fillPlatformLocator/,
      /gotoPlatformPage/,
      /pressPlatformKey/,
      /clickPagePointWithMouse/,
      /\.click\s*\(/,
      /\.fill\s*\(/,
      /\.press\s*\(/,
      /keyboard\.press\s*\(/,
      /\.goto\s*\(/,
    ];

    for (const platform of migratedPlatforms) {
      for (const relativePath of platform.facadeFiles) {
        const source = await readSource(relativePath);
        for (const pattern of forbidden) {
          assert.doesNotMatch(
            source,
            pattern,
            `${relativePath} must delegate ${pattern} to a ${platform.platform} action module`,
          );
        }
      }
    }
  });

  it('keeps queue, persistence, receipts, and model calls outside page actions', async () => {
    const forbidden = [
      /TaskQueue/,
      /mutationReceipt/,
      /chat-operations\/runs/,
      /JobStore/,
      /saveJobRecord/,
      /from ['"][^'"]*\/(?:server|storage|rag)\//,
      /from ['"][^'"]*(?:openai|jd-parser|scoring)\.js['"];/,
    ];

    for (const platform of migratedPlatforms) {
      const actionFiles = await listTypeScriptFiles(platform.actionDirectory);
      assert.ok(actionFiles.length > 0, `${platform.platform} must expose action modules`);
      for (const relativePath of actionFiles) {
        const source = await readSource(relativePath);
        for (const pattern of forbidden) {
          assert.doesNotMatch(source, pattern, `${relativePath} must not own ${pattern}`);
        }
      }
    }
  });

  it('keeps platform parsers pure and independent from browser controls', async () => {
    const forbidden = [
      /from ['"]playwright['"]/,
      /from ['"][^'"]*\/browser\/pacing\.js['"]/,
      /from ['"][^'"]*\/(?:server|storage|rag)\//,
      /from ['"][^'"]*(?:openai|jd-parser|scoring)\.js['"];/,
      /\.click\s*\(/,
      /\.fill\s*\(/,
      /\.press\s*\(/,
      /\.goto\s*\(/,
    ];

    for (const platform of migratedPlatforms) {
      if (!platform.parsingDirectory) {
        continue;
      }
      const parserFiles = await listTypeScriptFiles(platform.parsingDirectory);
      assert.ok(parserFiles.length > 0, `${platform.platform} must expose pure parser modules`);
      for (const relativePath of parserFiles) {
        const source = await readSource(relativePath);
        for (const pattern of forbidden) {
          assert.doesNotMatch(source, pattern, `${relativePath} must not own ${pattern}`);
        }
      }
    }
  });

  it('keeps Talent Mapping batch and read-only detail actions in concrete platform domains', async () => {
    const expectedActions = [
      {
        platform: '51job',
        candidateFile: 'platforms/51job/actions/candidate-actions.ts',
        resumeFile: 'platforms/51job/actions/resume-actions.ts',
        readBatch: 'read51jobCurrentCandidateBatch',
        advanceBatch: 'advance51jobToNextCandidateBatch',
        readDetail: 'read51jobCandidateProfileDetail',
      },
      {
        platform: 'liepin',
        candidateFile: 'platforms/liepin/actions/candidate-actions.ts',
        resumeFile: 'platforms/liepin/actions/resume-actions.ts',
        readBatch: 'readLiepinCurrentCandidateBatch',
        advanceBatch: 'advanceLiepinToNextCandidateBatch',
        readDetail: 'readLiepinCandidateProfileDetail',
      },
      {
        platform: 'zhilian',
        candidateFile: 'platforms/zhilian/actions/candidate-actions.ts',
        resumeFile: 'platforms/zhilian/actions/resume-actions.ts',
        readBatch: 'readZhilianCurrentCandidateBatch',
        advanceBatch: 'advanceZhilianToNextCandidateBatch',
        readDetail: 'readZhilianCandidateProfileDetail',
      },
    ];

    for (const expected of expectedActions) {
      const [candidateSource, resumeSource] = await Promise.all([
        readSource(expected.candidateFile),
        readSource(expected.resumeFile),
      ]);
      assert.match(candidateSource, new RegExp(`export async function ${expected.readBatch}\\b`));
      assert.match(candidateSource, new RegExp(`export async function ${expected.advanceBatch}\\b`));
      assert.match(candidateSource, /batchIdentity/);
      assert.match(candidateSource, /deadline/);
      assert.match(resumeSource, new RegExp(`export async function ${expected.readDetail}\\b`));
      assert.match(resumeSource, /candidate profile identity mismatch|exact candidate identity/i);
      assert.doesNotMatch(candidateSource, /TaskQueue|TalentMappingStore/);
      assert.doesNotMatch(resumeSource, /TaskQueue|TalentMappingStore/);
    }

    const zhilianReadSource = await readSource('platforms/zhilian/actions/resume-actions.ts');
    assert.doesNotMatch(zhilianReadSource, /copyZhilianColleagueForwardLink|delivery-actions/);
    const zhilianDeliverySource = await readSource('platforms/zhilian/actions/delivery-actions.ts');
    assert.match(zhilianDeliverySource, /collectZhilianResumeDeliveryMetadata/);
  });

  it('keeps 51job viewed-policy refresh and stable candidate snapshots in 51job actions', async () => {
    const [resultAction, candidateAction, subscribeRuntime, candidateRuntime, indexSource, legacyExtractor] = await Promise.all([
      readSource('platforms/51job/actions/result-actions.ts'),
      readSource('platforms/51job/actions/candidate-actions.ts'),
      readSource('browser/subscribe-search.ts'),
      readSource('browser/candidate-list.ts'),
      readSource('index.ts'),
      readSource('extraction/legacy-extractor.ts'),
    ]);

    assert.match(resultAction, /export async function apply51jobViewedCandidatePolicy\b/);
    assert.match(resultAction, /talent_hunt_resume_list/);
    assert.match(resultAction, /MutationObserver/);
    assert.match(resultAction, /refresh-start|refresh-response/);
    assert.match(candidateAction, /collectStable51jobCandidateList/);
    assert.doesNotMatch(candidateAction, /browser\/candidate-list/);

    assert.match(subscribeRuntime, /apply51jobViewedCandidatePolicyRef/);
    assert.doesNotMatch(subscribeRuntime, /set51jobViewedFilterChecked|viewedFilterSelector|label\.el-checkbox:has-text\("我已看"\)/);
    assert.doesNotMatch(candidateRuntime, /\.virtual_list|no_interested_|el-loading-mask|base-page-loading/);
    assert.doesNotMatch(indexSource, /platformAdapter\.platform === '51job'\s*\?\s*await extractCandidateListRef/);
    assert.doesNotMatch(legacyExtractor, /export async function extractCandidateListFromPage\b/);
  });

  it('keeps 51job search-subscription controls in the platform action owner', async () => {
    const searchAction = await readSource('platforms/51job/actions/search-actions.ts');
    assert.match(searchAction, /export async function openPageLevelSearch\b/);
    assert.match(searchAction, /export async function fill51jobSearchKeyword\b/);
    assert.match(searchAction, /export async function expand51jobAdvancedFilters\b/);
    assert.match(searchAction, /export async function save51jobSearchCondition\b/);
    await assert.rejects(
      readSource('browser/51job-search-subscription.ts'),
      /ENOENT/,
    );
  });

  it('builds core saved-search evidence from page observations instead of target echoes', async () => {
    const sources = await Promise.all([
      readSource('browser/subscribe-search.ts'),
      readSource('platforms/liepin/actions/search-actions.ts'),
      readSource('platforms/zhilian/actions/search-actions.ts'),
    ]);
    for (const source of sources) {
      assert.doesNotMatch(source, /observedKeyword:\s*target\.expectedKeyword/);
      assert.doesNotMatch(source, /observedName:\s*target\.name/);
      assert.match(source, /observedKeyword/);
      assert.match(source, /observedName/);
    }
  });

  it('keeps Liepin page behavior in concrete domain action owners', async () => {
    const [authenticationSource, navigationSource, searchSource, filterSource, candidateSource, resumeSource, forwardingSource] = await Promise.all([
      readSource('platforms/liepin/actions/authentication.ts'),
      readSource('platforms/liepin/actions/navigation-actions.ts'),
      readSource('platforms/liepin/actions/search-actions.ts'),
      readSource('platforms/liepin/actions/filter-actions.ts'),
      readSource('platforms/liepin/actions/candidate-actions.ts'),
      readSource('platforms/liepin/actions/resume-actions.ts'),
      readSource('platforms/liepin/actions/forwarding-actions.ts'),
    ]);

    assert.match(authenticationSource, /export async function assertLiepinAuthenticated\b/);
    assert.match(navigationSource, /export async function openLiepinRecruiterSearchPage\b/);
    assert.match(navigationSource, /export async function openLiepinAuthenticatedHome\b/);
    assert.match(searchSource, /export async function openLiepinDirectSearch\b/);
    assert.match(searchSource, /export async function openLiepinSubscribeSearch\b/);
    assert.match(filterSource, /export async function applyLiepinSearchCondition\b/);
    assert.match(filterSource, /export async function discoverLiepinSearchFilters\b/);
    assert.match(candidateSource, /export async function extractLiepinCandidateList\b/);
    assert.match(resumeSource, /export async function openLiepinResumePage\b/);
    assert.match(resumeSource, /export async function parseLiepinResumeDetail\b/);
    assert.match(forwardingSource, /export async function forwardLiepinResumeToFrequentContact\b/);
    assert.match(forwardingSource, /data-autorecruit-liepin-forward-target/);

    for (const domainSource of [navigationSource, searchSource, filterSource, candidateSource, resumeSource, forwardingSource]) {
      assert.doesNotMatch(domainSource, /internal-page-actions/);
    }
    await assert.rejects(
      readSource('platforms/liepin/actions/internal-page-actions.ts'),
      /ENOENT/,
    );
  });

  it('keeps Zhilian page behavior in concrete domain action owners', async () => {
    const [authenticationSource, navigationSource, searchSource, searchWorkflowSource, filterSource, candidateSource, resumeSource, deliverySource] = await Promise.all([
      readSource('platforms/zhilian/actions/authentication.ts'),
      readSource('platforms/zhilian/actions/navigation-actions.ts'),
      readSource('platforms/zhilian/actions/search-actions.ts'),
      readSource('platforms/zhilian/actions/search-entry-actions.ts'),
      readSource('platforms/zhilian/actions/filter-actions.ts'),
      readSource('platforms/zhilian/actions/candidate-actions.ts'),
      readSource('platforms/zhilian/actions/resume-actions.ts'),
      readSource('platforms/zhilian/actions/delivery-actions.ts'),
    ]);

    assert.match(authenticationSource, /export async function assertZhilianAuthenticated\b/);
    assert.match(navigationSource, /export async function openZhilianRecruiterHome\b/);
    assert.match(searchSource, /export async function openZhilianSubscribeSearch\b/);
    assert.match(searchSource, /export async function prepareZhilianSearchSurface\b/);
    assert.match(searchWorkflowSource, /export async function openZhilianDirectSearch\b/);
    assert.match(searchWorkflowSource, /export async function prepareZhilianSearchConditionPage\b/);
    assert.match(filterSource, /export async function applyZhilianSearchCondition\b/);
    assert.match(filterSource, /export async function discoverZhilianStaticSearchFilters\b/);
    assert.match(candidateSource, /export async function extractZhilianCandidateList\b/);
    assert.match(resumeSource, /export async function openZhilianResumeDetail\b/);
    assert.match(resumeSource, /async function parseZhilianResumeDetailFromPage\b/);
    assert.match(deliverySource, /export async function collectZhilianResumeDeliveryMetadata\b/);

    assert.doesNotMatch(searchSource, /from ['"]\.\/filter-actions\.js['"]/);
    assert.doesNotMatch(filterSource, /from ['"]\.\/search-entry-actions\.js['"]/);
    assert.match(searchWorkflowSource, /from ['"]\.\/search-actions\.js['"]/);
    assert.match(searchWorkflowSource, /from ['"]\.\/filter-actions\.js['"]/);

    for (const domainSource of [navigationSource, searchSource, searchWorkflowSource, filterSource, candidateSource, resumeSource, deliverySource]) {
      assert.doesNotMatch(domainSource, /internal-page-actions/);
    }
    await assert.rejects(
      readSource('platforms/zhilian/actions/internal-page-actions.ts'),
      /ENOENT/,
    );
  });
});

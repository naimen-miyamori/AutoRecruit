import fs from 'node:fs/promises';
import path from 'node:path';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import { diffCandidateListSummaries, summarizeCandidateList } from '../extraction/candidate-list-validation.js';
import { extractCandidateListFromPage, extractCandidateListFromSource } from '../extraction/legacy-extractor.js';
import { buildRawPageSource } from '../extraction/page-source.js';
import { getPlatformAdapter, parsePlatformArg } from '../platforms/registry.js';

interface ValidationArtifact {
  keyword: string;
  fetchedAt: string;
  pagePath: string;
  diff?: ReturnType<typeof diffCandidateListSummaries>;
  failure?: {
    legacy?: string;
    source?: string;
  };
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function buildArtifactDir(keyword: string): string {
  return path.join(config.dataDir, 'candidate-list-validation', keyword.replace(/\s+/g, '-'));
}

async function writeArtifact(keyword: string, artifact: ValidationArtifact): Promise<string> {
  const outputDir = buildArtifactDir(keyword);
  await ensureDir(outputDir);
  const artifactPath = path.join(outputDir, 'latest-diff.json');
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifactPath;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const platformFlagIndex = argv.indexOf('--platform');
  const platform = platformFlagIndex >= 0
    ? parsePlatformArg(argv[platformFlagIndex + 1])
    : parsePlatformArg(undefined);
  const keyword = argv.filter((_, index) => index !== platformFlagIndex && index !== platformFlagIndex + 1)[0];

  if (!keyword) {
    throw new Error('Usage: tsx src/scripts/validate-candidate-list-extraction.ts [--platform <platform>] <keyword>');
  }

  const fetchedAt = new Date().toISOString();
  const session = await ensureAuthenticatedBrowserSession(platform);
  const platformAdapter = getPlatformAdapter(platform);

  try {
    const searchPage = await platformAdapter.openSubscribeSearch(session.page, keyword);
    const source = await buildRawPageSource(searchPage, fetchedAt);
    const outputDir = buildArtifactDir(keyword);
    await ensureDir(outputDir);
    const pagePath = path.join(outputDir, `${fetchedAt.replace(/[:.]/g, '-')}.page-source.json`);
    await fs.writeFile(pagePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');

    let legacySummary: ReturnType<typeof summarizeCandidateList> | undefined;
    let sourceSummary: ReturnType<typeof summarizeCandidateList> | undefined;
    const failure: ValidationArtifact['failure'] = {};

    try {
      const legacyResult = await extractCandidateListFromPage(searchPage);
      legacySummary = summarizeCandidateList(legacyResult.candidates);
    } catch (error) {
      failure.legacy = error instanceof Error ? error.message : String(error);
    }

    try {
      const sourceResult = await extractCandidateListFromSource(source);
      sourceSummary = summarizeCandidateList(sourceResult.candidates);
    } catch (error) {
      failure.source = error instanceof Error ? error.message : String(error);
    }

    const diff = !failure.legacy && !failure.source
      ? diffCandidateListSummaries(legacySummary!, sourceSummary!)
      : undefined;

    const artifactPath = await writeArtifact(keyword, {
      keyword,
      fetchedAt,
      pagePath,
      failure: failure.legacy || failure.source ? failure : undefined,
      diff: diff ?? undefined,
    });

    console.log(JSON.stringify({
      keyword,
      fetchedAt,
      pagePath,
      artifactPath,
      same: !failure.legacy && !failure.source && !diff,
      failed: Boolean(failure.legacy || failure.source),
    }, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

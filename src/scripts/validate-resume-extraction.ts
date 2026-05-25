import fs from 'node:fs/promises';
import path from 'node:path';
import { parseResumeFromSource } from '../browser/resume-detail.js';
import { config } from '../config.js';
import { extractResumeFromSource as extractResumeFromCrawl4AiSource } from '../extraction/crawl4ai-extractor.js';
import { diffResumeSummaries, summarizeResume } from '../extraction/resume-validation.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { JobStore } from '../storage/job-store.js';

interface ValidationArtifact {
  candidateId: string;
  jobKey: string;
  hasDomSnapshot: boolean;
  snapshotPath: string;
  diff?: ReturnType<typeof diffResumeSummaries>;
  failure?: {
    legacy?: string;
    crawl4ai?: string;
  };
}

interface ValidationCounts {
  total: number;
  same: number;
  different: number;
  failed: number;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function buildArtifactDir(platform: SupportedPlatform, jobKey: string): string {
  return path.join(config.dataDir, platform, 'jobs', jobKey, 'validation-diffs');
}

function buildSnapshotPath(platform: SupportedPlatform, jobKey: string, candidateId: string): string {
  return path.join(config.dataDir, platform, 'jobs', jobKey, 'snapshots', `${candidateId}.txt`);
}

async function writeArtifact(platform: SupportedPlatform, jobKey: string, candidateId: string, artifact: ValidationArtifact): Promise<void> {
  const outputDir = buildArtifactDir(platform, jobKey);
  await ensureDir(outputDir);
  await fs.writeFile(
    path.join(outputDir, `${candidateId}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
}

function printSummary(jobKey: string, counts: ValidationCounts): void {
  console.log(JSON.stringify({ jobKey, ...counts }, null, 2));
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2] ?? '51job');
  const jobKey = process.argv[3];

  if (!jobKey) {
    throw new Error('Usage: tsx src/scripts/validate-resume-extraction.ts <platform> <jobKey>');
  }

  const store = new JobStore();
  const snapshots = await store.listStoredResumeSnapshots(platform, jobKey);
  const counts: ValidationCounts = {
    total: snapshots.length,
    same: 0,
    different: 0,
    failed: 0,
  };

  for (const snapshot of snapshots) {
    const candidate = {
      candidateId: snapshot.candidateId,
      name: snapshot.name,
      resumeUrl: snapshot.resumeUrl,
    };
    const source = {
      url: snapshot.resumeUrl ?? '',
      title: '',
      html: '',
      visibleText: snapshot.snapshotContent,
      fetchedAt: new Date().toISOString(),
    };

    let legacySummary: ReturnType<typeof summarizeResume> | undefined;
    let crawl4aiSummary: ReturnType<typeof summarizeResume> | undefined;
    const failure: ValidationArtifact['failure'] = {};

    try {
      const legacyResume = parseResumeFromSource(source, candidate, snapshot.domSnapshot);
      legacySummary = summarizeResume(legacyResume);
    } catch (error) {
      failure.legacy = error instanceof Error ? error.message : String(error);
    }

    try {
      const crawl4aiResult = await extractResumeFromCrawl4AiSource(source, candidate, snapshot.domSnapshot);
      crawl4aiSummary = summarizeResume(crawl4aiResult.resume);
    } catch (error) {
      failure.crawl4ai = error instanceof Error ? error.message : String(error);
    }

    if (failure.legacy || failure.crawl4ai) {
      counts.failed += 1;
      await writeArtifact(platform, jobKey, snapshot.candidateId, {
        candidateId: snapshot.candidateId,
        jobKey,
        hasDomSnapshot: Boolean(snapshot.domSnapshot),
        snapshotPath: buildSnapshotPath(platform, jobKey, snapshot.candidateId),
        failure,
      });
      continue;
    }

    const diff = diffResumeSummaries(legacySummary!, crawl4aiSummary!);

    if (diff) {
      counts.different += 1;
      await writeArtifact(platform, jobKey, snapshot.candidateId, {
        candidateId: snapshot.candidateId,
        jobKey,
        hasDomSnapshot: Boolean(snapshot.domSnapshot),
        snapshotPath: buildSnapshotPath(platform, jobKey, snapshot.candidateId),
        diff,
      });
      continue;
    }

    counts.same += 1;
  }

  printSummary(jobKey, counts);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

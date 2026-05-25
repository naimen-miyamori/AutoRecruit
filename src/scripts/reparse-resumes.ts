import { extractResumeFromSource as extractResumeFromCrawl4AiSource } from '../extraction/crawl4ai-extractor.js';
import { buildResumeSourceFromSnapshot, validateResumeExtraction } from '../extraction/extractor.js';
import { createLegacyExtractionBoundary } from '../extraction/legacy-extractor.js';
import { getPlatformAdapter, parsePlatformArg } from '../platforms/registry.js';
import { JobStore } from '../storage/job-store.js';

function buildOfflineSnapshotPage(snapshotContent: string, resumeUrl: string) {
  return {
    url: () => resumeUrl,
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => snapshotContent,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];

  if (!jobKey) {
    throw new Error('Usage: tsx src/scripts/reparse-resumes.ts <platform> <jobKey>');
  }

  const store = new JobStore();
  const extractionBoundary = createLegacyExtractionBoundary();
  const platformAdapter = getPlatformAdapter(platform);
  const snapshots = await store.listStoredResumeSnapshots(platform, jobKey);

  let updated = 0;
  let migratedSnapshots = 0;

  for (const snapshot of snapshots) {
    const source = buildResumeSourceFromSnapshot(snapshot.snapshotContent, snapshot.resumeUrl);
    const candidate = {
      candidateId: snapshot.candidateId,
      name: snapshot.name,
      resumeUrl: snapshot.resumeUrl,
    };
    const resumeUrl = snapshot.resumeUrl ?? '';

    const reparsed = platform === 'liepin'
      ? validateResumeExtraction({
        resume: await platformAdapter.parseResumeDetail(buildOfflineSnapshotPage(snapshot.snapshotContent, resumeUrl), candidate),
        domSnapshot: snapshot.domSnapshot,
        source,
      })
      : await extractResumeFromCrawl4AiSource(source, candidate, snapshot.domSnapshot).catch(() => extractionBoundary.extractResumeFromSource(source, candidate, snapshot.domSnapshot));

    await store.saveCandidateResume(platform, jobKey, {
      ...reparsed.resume,
      resumeUrl: snapshot.resumeUrl,
    }, snapshot.snapshotContent, snapshot.domSnapshot);

    updated += 1;
    if (snapshot.migratedSnapshot) {
      migratedSnapshots += 1;
    }
  }

  console.log(JSON.stringify({ jobKey, totalFiles: snapshots.length, updated, migratedSnapshots }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { extractWorkLines } from '../browser/resume-detail.js';
import { parsePlatformArg } from '../platforms/registry.js';

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];
  const candidateId = process.argv[4];

  if (!jobKey || !candidateId) {
    throw new Error('Usage: tsx src/scripts/debug-work-lines.ts <platform> <jobKey> <candidateId>');
  }

  const snapshotPath = path.join(config.dataDir, platform, 'jobs', jobKey, 'snapshots', `${candidateId}.txt`);
  const snapshot = await fs.readFile(snapshotPath, 'utf8');
  const workLines = extractWorkLines(snapshot);
  console.log(JSON.stringify(workLines, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

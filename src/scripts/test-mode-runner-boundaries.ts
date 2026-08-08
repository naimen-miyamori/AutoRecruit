import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerRoot = path.join(sourceRoot, 'mode-runners');

async function runnerFiles(): Promise<string[]> {
  return (await readdir(runnerRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(runnerRoot, entry.name));
}

describe('stable mode runner boundaries', () => {
  it('keeps raw CLI, queue, HTTP, and DOM mechanics outside mode runners', async () => {
    const forbidden = [
      /process\.argv/,
      /TaskQueue/,
      /handleApiRequest/,
      /from ['"][^'"]*\/server\/(?:routes|task-queue|task-scheduler)\.js['"]/,
      /internal-page-actions/,
      /locator\s*\(/,
      /\.click\s*\(/,
      /\.fill\s*\(/,
      /\.press\s*\(/,
      /\.goto\s*\(/,
    ];

    for (const filePath of await runnerFiles()) {
      const source = await readFile(filePath, 'utf8');
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, `${path.relative(sourceRoot, filePath)} must not own ${pattern}`);
      }
    }
  });

  it('moves classified low-risk and multi-platform dispatch owners out of index', async () => {
    const indexSource = await readFile(path.join(sourceRoot, 'index.ts'), 'utf8');
    for (const oldOwner of [
      'runJdQuestion',
      'runTalentMapping',
      'runSearchSubscription',
      'runBossTalentSearchMode',
      'runBossGreetMode',
      'runBossChatOperationMode',
      'runBossJobSyncMode',
      'runBossAutoChat',
      'runBossSavedSearchBinding',
      'runBatchJobs',
      'runSinglePlatform',
    ]) {
      assert.doesNotMatch(
        indexSource,
        new RegExp(`(?:async\\s+)?function\\s+${oldOwner}\\b`),
        `${oldOwner} must have one owner under src/mode-runners`,
      );
    }
    assert.match(indexSource, /runAllPlatformsCaptureMode\(input, captureDispatchDependencies\)/);
    assert.match(indexSource, /runBatchCaptureMode\(input, captureDispatchDependencies\)/);
    assert.match(indexSource, /runSinglePlatformCapture\(/);
  });

  it('keeps the capture engine independent from entry surfaces and mode runners', async () => {
    const [indexSource, engineSource, configSource, batchInputSource] = await Promise.all([
      readFile(path.join(sourceRoot, 'index.ts'), 'utf8'),
      readFile(path.join(sourceRoot, 'capture-engine.ts'), 'utf8'),
      readFile(path.join(runnerRoot, 'capture-config.ts'), 'utf8'),
      readFile(path.join(runnerRoot, 'batch-input.ts'), 'utf8'),
    ]);

    assert.doesNotMatch(indexSource, /export async function runResumeCaptureFlow\b/);
    assert.doesNotMatch(indexSource, /function (?:captureCandidateResume|scoreCapturedResumes|recoverBossScreeningOutbox)\b/);
    assert.doesNotMatch(indexSource, /function (?:resolveResumeCaptureContext|resolveBossScreeningSettings|resolvePostScoreRoutingSettings|parseBatchJobItem|loadBatchJobInputs)\b/);
    assert.match(engineSource, /export function createCaptureEngine\b/);
    assert.match(engineSource, /async function runResumeCaptureFlow\b/);
    assert.match(configSource, /export async function resolveResumeCaptureContext\b/);
    assert.match(configSource, /export async function resolveBossScreeningSettings\b/);
    assert.match(configSource, /export async function resolvePostScoreRoutingSettings\b/);
    assert.match(batchInputSource, /export async function loadBatchJobInputs\b/);
    assert.match(batchInputSource, /function parseBatchJobItem\b/);
    assert.doesNotMatch(engineSource, /from ['"].*mode-runners\//);
    assert.doesNotMatch(engineSource, /from ['"].*server\/(?:routes|task-queue|task-scheduler)/);
    assert.doesNotMatch(engineSource, /process\.argv|TaskQueue|handleApiRequest/);
  });
});

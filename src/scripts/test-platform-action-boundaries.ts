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

    const zhilianReadSource = await readSource('platforms/zhilian/actions/internal-page-actions.ts');
    assert.doesNotMatch(zhilianReadSource, /copyZhilianColleagueForwardLink/);
    const zhilianDeliverySource = await readSource('platforms/zhilian/actions/delivery-actions.ts');
    assert.match(zhilianDeliverySource, /collectZhilianResumeDeliveryMetadata/);
  });
});

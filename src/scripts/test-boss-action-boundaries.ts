import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowFiles = [
  'platforms/boss-adapter.ts',
  'platforms/boss-chat.ts',
  'platforms/boss-operations.ts',
  'platforms/boss-talent.ts',
  'platforms/boss-jobs.ts',
];

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(sourceRoot, relativePath), 'utf8');
}

describe('Boss action module boundaries', () => {
  it('keeps user-visible browser controls out of workflow facades', async () => {
    const forbidden = [
      /clickPlatformLocator/,
      /clickBossControl/,
      /\.click\s*\(/,
      /\.fill\s*\(/,
      /\.press\s*\(/,
      /keyboard\.press\s*\(/,
      /\.goto\s*\(/,
    ];
    for (const relativePath of workflowFiles) {
      const source = await readSource(relativePath);
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, `${relativePath} must delegate ${pattern} to a Boss action module`);
      }
    }
  });

  it('keeps read actions independent from mutation actions', async () => {
    const source = await readSource('platforms/boss/actions/conversation-read-actions.ts');
    assert.doesNotMatch(source, /conversation-mutation-actions/);
  });

  it('keeps queue, persistence, and receipts outside page actions', async () => {
    const actionFiles = [
      'context.ts',
      'conversation-read-actions.ts',
      'conversation-mutation-actions.ts',
      'job-actions.ts',
      'navigation-actions.ts',
      'resume-actions.ts',
      'resume-detail-actions.ts',
      'search-actions.ts',
      'talent-actions.ts',
    ];
    for (const filename of actionFiles) {
      const source = await readSource(`platforms/boss/actions/${filename}`);
      assert.doesNotMatch(source, /TaskQueue|mutationReceipt|chat-operations\/runs|JobStore|saveJobRecord/);
    }
  });
});

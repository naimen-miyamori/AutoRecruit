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
      'candidate-actions.ts',
      'candidate-detail-actions.ts',
      'conversation-read-actions.ts',
      'conversation-mutation-actions.ts',
      'filter-actions.ts',
      'job-actions.ts',
      'navigation-actions.ts',
      'post-open-actions.ts',
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

  it('keeps Boss position synchronization independent from LLM JD parsing', async () => {
    const source = await readSource('platforms/boss-jobs.ts');
    assert.doesNotMatch(source, /parsers\/jd-parser|parseJobDescription|completeJsonTextFromOpenAI|codex-session-provider/);
  });

  it('keeps normal search, filters, candidates, details, and navigation in distinct owners', async () => {
    const [navigationSource, searchSource, searchWorkflowSource, filterSource, candidateSource, detailSource, postOpenSource] = await Promise.all([
      readSource('platforms/boss/actions/navigation-actions.ts'),
      readSource('platforms/boss/actions/search-actions.ts'),
      readSource('platforms/boss/actions/search-entry-actions.ts'),
      readSource('platforms/boss/actions/filter-actions.ts'),
      readSource('platforms/boss/actions/candidate-actions.ts'),
      readSource('platforms/boss/actions/candidate-detail-actions.ts'),
      readSource('platforms/boss/actions/post-open-actions.ts'),
    ]);

    assert.match(navigationSource, /export async function assertBossAuthenticated\b/);
    assert.match(navigationSource, /export async function openBossAuthenticatedHome\b/);
    assert.match(searchSource, /export async function submitBossPreparedSearch\b/);
    assert.match(searchSource, /export async function prepareBossSearchConditionPage\b/);
    assert.match(searchWorkflowSource, /export async function openBossSubscribeSearch\b/);
    assert.match(searchWorkflowSource, /export async function openBossDirectSearch\b/);
    assert.match(filterSource, /export async function applyBossDirectSearch\b/);
    assert.match(filterSource, /async function discoverBossSearchFilters\b/);
    assert.match(candidateSource, /export async function extractBossCandidateList\b/);
    assert.match(detailSource, /export async function openBossResumeDetail\b/);
    assert.match(detailSource, /export async function visitBossSeenCandidateDetail\b/);
    assert.match(postOpenSource, /export async function runBossPostOpenActions\b/);

    assert.doesNotMatch(filterSource, /(?:async\s+)?function\s+(?:openBossSubscribeSearch|openBossDirectSearch|prepareBossSearchConditionPage)\b/);
    assert.doesNotMatch(searchSource, /(?:async\s+)?function\s+(?:extractBossCandidateList|openBossResumeDetail|visitBossSeenCandidateDetail|runBossPostOpenActions)\b/);
    assert.doesNotMatch(searchSource, /from ['"]\.\/filter-actions\.js['"]/);
    assert.match(searchWorkflowSource, /from ['"]\.\/search-actions\.js['"]/);
    assert.match(searchWorkflowSource, /from ['"]\.\/filter-actions\.js['"]/);
    assert.doesNotMatch(candidateSource, /resume-detail-actions/);
  });
});

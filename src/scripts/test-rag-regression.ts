import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  normalizeRagRegressionSuite,
  readRagRegressionSuiteFile,
  runRagRegression,
} from '../rag/regression.js';
import { normalizeRagAnswerEvalCases } from '../rag/answer-eval.js';
import type { RagAnswerEvalSummary } from '../rag/answer-eval.js';
import { normalizeRagEvalCases } from '../rag/eval.js';
import type { RagEvalSummary } from '../rag/eval.js';
import { config } from '../config.js';
import { preflightRagBaselineEnvironment, runOfflineRagBaseline, runRagBaseline } from '../rag/baseline.js';
import type { RagBaselineSummary } from '../rag/baseline.js';
import { readRagFixtureConversations, readRagFixtureJobs, seedRagFixtures } from '../rag/seed-fixtures.js';
import type { RagFixtureSeedSummary } from '../rag/seed-fixtures.js';
import { JobStore } from '../storage/job-store.js';
import { buildOfflineRagBaselineCiSummary } from './rag-baseline-offline.js';

const tempDirs: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalQdrantUrl = process.env.QDRANT_URL;
const originalEmbeddingProvider = process.env.RAG_EMBEDDING_PROVIDER;
const originalEmbeddingLocalUrl = process.env.RAG_EMBEDDING_LOCAL_URL;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-regression-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function buildRetrievalSummary(overrides: Partial<RagEvalSummary>): RagEvalSummary {
  return {
    platform: '51job',
    jobKey: 'rag-regression',
    caseCount: 1,
    passedCount: 1,
    failedCount: 0,
    metrics: { hitRate: 1 },
    cases: [],
    ...overrides,
  };
}

function buildAnswerSummary(overrides: Partial<RagAnswerEvalSummary>): RagAnswerEvalSummary {
  return {
    platform: '51job',
    jobKey: 'rag-regression',
    caseCount: 1,
    passedCount: 1,
    failedCount: 0,
    metrics: { passRate: 1 },
    cases: [],
    ...overrides,
  };
}

function buildSeedSummary(overrides: Partial<RagFixtureSeedSummary> = {}): RagFixtureSeedSummary {
  return {
    fixtureDir: '/tmp/fixtures/rag',
    jobCount: 1,
    createdCount: 1,
    overwrittenCount: 0,
    skippedCount: 0,
    indexedCount: 1,
    conversationCount: 0,
    ingestedConversationCount: 0,
    conversations: [],
    items: [{
      platform: '51job',
      jobKey: '优衣库',
      filePath: 'fixtures/rag/jobs/51job/优衣库/jd.json',
      status: 'created',
    }],
    ...overrides,
  };
}

describe('RAG regression', () => {
  it('normalizes suite arrays and derives job keys from keywords', () => {
    const suite = normalizeRagRegressionSuite([{
      id: 'sea-sales',
      platform: '51job',
      keyword: '东南亚 销售',
      retrievalEvalFile: './retrieval.json',
      answerEvalFile: './answer.json',
    }]);

    assert.equal(suite.items.length, 1);
    assert.equal(suite.items[0]?.platform, '51job');
    assert.equal(suite.items[0]?.jobKey, '东南亚-销售');
    assert.throws(
      () => normalizeRagRegressionSuite([]),
      /at least one item/,
    );
    assert.throws(
      () => normalizeRagRegressionSuite([{ platform: '51job', keyword: 'x' }]),
      /retrievalEvalFile or answerEvalFile/,
    );
  });

  it('runs retrieval and answer suites from files and summarizes failures', async () => {
    const tempDir = await makeTempDir();
    await fs.mkdir(path.join(tempDir, 'cases'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'cases', 'retrieval.json'), JSON.stringify([{
      question: '薪资范围是多少？',
      expectedTextIncludes: ['15-25K'],
    }]), 'utf8');
    await fs.writeFile(path.join(tempDir, 'cases', 'answer.json'), JSON.stringify([{
      question: '薪资范围是多少？',
      expectedAnswerIncludes: ['15-25K'],
    }]), 'utf8');

    const summary = await runRagRegression({
      suite: normalizeRagRegressionSuite([{
        id: 'sea-sales',
        platform: '51job',
        jobKey: 'sea-sales',
        retrievalEvalFile: './cases/retrieval.json',
        answerEvalFile: './cases/answer.json',
      }]),
      suiteDir: tempDir,
      evaluateRetrieval: async (options) => {
        assert.equal(options.cases[0]?.question, '薪资范围是多少？');
        return buildRetrievalSummary({
          jobKey: options.jobKey,
          failedCount: 1,
          passedCount: 0,
          metrics: { hitRate: 0 },
        });
      },
      evaluateAnswers: async (options) => {
        assert.equal(options.cases[0]?.question, '薪资范围是多少？');
        return buildAnswerSummary({
          jobKey: options.jobKey,
          failedCount: 0,
        });
      },
    });

    assert.equal(summary.itemCount, 1);
    assert.equal(summary.passed, false);
    assert.equal(summary.failedItemCount, 1);
    assert.equal(summary.retrievalCaseCount, 1);
    assert.equal(summary.retrievalFailedCount, 1);
    assert.equal(summary.answerCaseCount, 1);
    assert.equal(summary.answerFailedCount, 0);
    assert.equal(summary.items[0]?.retrieval?.metrics.hitRate, 0);
  });

  it('reads suite files with an items wrapper and allows answer-only suites', async () => {
    const tempDir = await makeTempDir();
    const suitePath = path.join(tempDir, 'suite.json');
    await fs.writeFile(suitePath, JSON.stringify({
      items: [{
        platform: '51job',
        jobKey: 'answer-only',
        answerEvalFile: './answer.json',
      }],
    }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'answer.json'), JSON.stringify([{
      question: '是否提供住宿？',
      expectedAnswerIncludes: ['住宿补贴'],
    }]), 'utf8');

    const suite = await readRagRegressionSuiteFile(suitePath);
    const summary = await runRagRegression({
      suite,
      suiteDir: tempDir,
      evaluateAnswers: async (options) => buildAnswerSummary({ jobKey: options.jobKey }),
    });

    assert.equal(summary.passed, true);
    assert.equal(summary.retrievalCaseCount, 0);
    assert.equal(summary.answerCaseCount, 1);
    assert.equal(summary.items[0]?.retrieval, undefined);
    assert.equal(summary.items[0]?.answer?.jobKey, 'answer-only');
  });

  it('can skip answer eval for offline retrieval-only regression', async () => {
    const tempDir = await makeTempDir();
    await fs.writeFile(path.join(tempDir, 'retrieval.json'), JSON.stringify([{
      question: '薪资范围是多少？',
      expectedTextIncludes: ['15-25K'],
    }]), 'utf8');
    await fs.writeFile(path.join(tempDir, 'answer.json'), JSON.stringify([{
      question: '薪资范围是多少？',
      expectedAnswerIncludes: ['15-25K'],
    }]), 'utf8');
    let answerCalled = false;

    const summary = await runRagRegression({
      suite: normalizeRagRegressionSuite([{
        platform: '51job',
        jobKey: 'offline-only',
        retrievalEvalFile: './retrieval.json',
        answerEvalFile: './answer.json',
      }]),
      suiteDir: tempDir,
      includeAnswerEval: false,
      evaluateRetrieval: async (options) => buildRetrievalSummary({ jobKey: options.jobKey }),
      evaluateAnswers: async () => {
        answerCalled = true;
        return buildAnswerSummary({});
      },
    });

    assert.equal(summary.passed, true);
    assert.equal(summary.retrievalCaseCount, 1);
    assert.equal(summary.answerCaseCount, 0);
    assert.equal(summary.items[0]?.answer, undefined);
    assert.equal(answerCalled, false);
  });

  it('keeps checked-in baseline fixtures parseable', async () => {
    const fixtureDir = path.join(repoRoot, 'fixtures', 'rag');
    const suite = await readRagRegressionSuiteFile(path.join(fixtureDir, 'regression.json'));
    const baseline = suite.items.find((item) => item.id === '51job-store-manager-baseline');

    assert.ok(baseline);
    assert.equal(baseline.platform, '51job');
    assert.equal(baseline.jobKey, '优衣库');
    assert.equal(baseline.retrievalEvalFile, './store-manager.retrieval.json');
    assert.equal(baseline.answerEvalFile, './store-manager.answer.json');

    const retrievalPayload = JSON.parse(
      await fs.readFile(path.join(fixtureDir, baseline.retrievalEvalFile), 'utf8'),
    ) as unknown;
    const answerPayload = JSON.parse(
      await fs.readFile(path.join(fixtureDir, baseline.answerEvalFile), 'utf8'),
    ) as unknown;
    const retrievalCases = normalizeRagEvalCases(retrievalPayload);
    const answerCases = normalizeRagAnswerEvalCases(answerPayload);

    assert.equal(retrievalCases.length, 10);
    assert.equal(answerCases.length, 10);
    assert.equal(retrievalCases.some((item) => item.id === 'housing-allowance'), true);
    assert.equal(retrievalCases.some((item) => item.id === 'unverified-transport-allowance'), true);
    assert.equal(answerCases.some((item) => item.id === 'housing-allowance-answer'), true);
    assert.equal(answerCases.some((item) => item.id === 'unverified-transport-allowance-answer'), true);
    assert.equal(retrievalCases.some((item) => item.expectNoAnswer), true);
    assert.equal(answerCases.some((item) => item.expectNoAnswer), true);
  });

  it('reads and seeds checked-in fixture job records', async () => {
    const fixtureDir = path.join(repoRoot, 'fixtures', 'rag');
    const tempDir = await makeTempDir();
    process.env.DATA_DIR = tempDir;
    (config as { dataDir: string }).dataDir = tempDir;

    const jobs = await readRagFixtureJobs(fixtureDir);
    assert.equal(jobs.some((job) => job.platform === '51job' && job.jobKey === '优衣库'), true);
    const conversations = await readRagFixtureConversations(fixtureDir);
    const hiringPolicy = conversations.find((conversation) => conversation.conversationId === 'hiring-policy');
    assert.ok(hiringPolicy);
    assert.equal(hiringPolicy.platform, '51job');
    assert.equal(hiringPolicy.jobKey, '优衣库');
    assert.equal(hiringPolicy.turns.length, 4);

    const summary = await seedRagFixtures({
      fixtureDir,
      jobStore: new JobStore(),
    });
    const stored = await new JobStore().readJobRecord('51job', '优衣库');

    assert.equal(summary.jobCount, 1);
    assert.equal(summary.createdCount, 1);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.indexedCount, 0);
    assert.equal(summary.conversationCount, 1);
    assert.equal(summary.ingestedConversationCount, 0);
    assert.equal(summary.conversations[0]?.status, 'loaded');
    assert.equal(stored.normalizedJob.title, '店长');
    assert.equal(stored.rawText.includes('税前8-12k'), true);
  });

  it('skips existing fixture jobs by default but can still index them', async () => {
    const fixtureDir = path.join(repoRoot, 'fixtures', 'rag');
    const tempDir = await makeTempDir();
    process.env.DATA_DIR = tempDir;
    (config as { dataDir: string }).dataDir = tempDir;
    const jobStore = new JobStore();
    let indexCallCount = 0;
    let ingestCallCount = 0;

    await seedRagFixtures({ fixtureDir, jobStore });
    const summary = await seedRagFixtures({
      fixtureDir,
      jobStore,
      index: true,
      indexJob: async (options) => {
        indexCallCount += 1;
        return {
          platform: options.platform,
          jobKey: options.jobKey,
          sourceCount: 1,
          chunkCount: 1,
          indexedChunkCount: 1,
          embeddingModel: 'test-embedding',
          vectorStore: 'test-vector-store',
          manifestPath: '/tmp/manifest.json',
        };
      },
      ingestConversation: async (options) => {
        ingestCallCount += 1;
        assert.equal(options.platform, '51job');
        assert.equal(options.jobKey, '优衣库');
        assert.equal(options.conversationId, 'hiring-policy');
        assert.equal(options.turns.some((turn) => turn.verified === true), true);
        return {
          platform: options.platform,
          jobKey: options.jobKey,
          conversationId: options.conversationId,
          conversationPath: '/tmp/conversation.jsonl',
          sourceCount: 2,
          chunkCount: 2,
          indexedChunkCount: 1,
          embeddingModel: 'test-embedding',
          vectorStore: 'test-vector-store',
          manifestPath: '/tmp/manifest.json',
        };
      },
    });

    assert.equal(summary.createdCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.indexedCount, 1);
    assert.equal(summary.conversationCount, 1);
    assert.equal(summary.ingestedConversationCount, 1);
    assert.equal(summary.conversations[0]?.status, 'ingested');
    assert.equal(indexCallCount, 1);
    assert.equal(ingestCallCount, 1);
  });

  it('preflights baseline environment requirements', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.QDRANT_URL;
    delete process.env.RAG_EMBEDDING_PROVIDER;
    delete process.env.RAG_EMBEDDING_LOCAL_URL;

    const defaultPreflight = preflightRagBaselineEnvironment();
    assert.equal(defaultPreflight.embeddingProvider, 'local-http');
    assert.deepStrictEqual(defaultPreflight.missing, ['QDRANT_URL']);

    process.env.RAG_EMBEDDING_PROVIDER = 'openai';
    const openAiPreflight = preflightRagBaselineEnvironment();
    assert.deepStrictEqual(openAiPreflight.missing.sort(), ['OPENAI_API_KEY', 'QDRANT_URL']);
  });

  it('runs baseline by seeding fixtures with indexing and then running regression', async () => {
    const fixtureDir = path.join(repoRoot, 'fixtures', 'rag');
    const suiteFile = path.join(fixtureDir, 'regression.json');
    process.env.QDRANT_URL = 'http://localhost:6333';
    delete process.env.RAG_EMBEDDING_PROVIDER;
    let seededWithIndex = false;

    const summary = await runRagBaseline({
      fixtureDir,
      suiteFile,
      checkQdrant: async () => undefined,
      seedFixtures: async (options) => {
        assert.equal(options.fixtureDir, fixtureDir);
        assert.equal(options.index, true);
        seededWithIndex = true;
        return buildSeedSummary({ fixtureDir });
      },
      runRegression: async (options) => {
        assert.equal(options.suite.items[0]?.jobKey, '优衣库');
        assert.equal(options.suiteDir, fixtureDir);
        return {
          itemCount: 1,
          passedItemCount: 1,
          failedItemCount: 0,
          retrievalCaseCount: 10,
          retrievalFailedCount: 0,
          answerCaseCount: 10,
          answerFailedCount: 0,
          passed: true,
          items: [],
        };
      },
    });

    assert.equal(seededWithIndex, true);
    assert.equal(summary.passed, true);
    assert.equal(summary.seed.indexedCount, 1);
    assert.equal(summary.regression.retrievalCaseCount, 10);
  });

  it('keeps baseline summary failed when regression fails', async () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    delete process.env.RAG_EMBEDDING_PROVIDER;

    const summary = await runRagBaseline({
      fixtureDir: path.join(repoRoot, 'fixtures', 'rag'),
      checkQdrant: async () => undefined,
      seedFixtures: async () => buildSeedSummary(),
      runRegression: async () => ({
        itemCount: 1,
        passedItemCount: 0,
        failedItemCount: 1,
        retrievalCaseCount: 1,
        retrievalFailedCount: 1,
        answerCaseCount: 0,
        answerFailedCount: 0,
        passed: false,
        items: [],
      }),
    });

    assert.equal(summary.passed, false);
    assert.equal(summary.regression.failedItemCount, 1);
  });

  it('fails baseline before seeding when Qdrant is not reachable', async () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    delete process.env.RAG_EMBEDDING_PROVIDER;
    let seeded = false;

    await assert.rejects(
      () => runRagBaseline({
        fixtureDir: path.join(repoRoot, 'fixtures', 'rag'),
        checkQdrant: async () => {
          throw new Error('Qdrant is not reachable at http://localhost:6333: connect ECONNREFUSED');
        },
        seedFixtures: async () => {
          seeded = true;
          return buildSeedSummary();
        },
      }),
      /Qdrant is not reachable/,
    );
    assert.equal(seeded, false);
  });

  it('runs offline baseline without OpenAI or Qdrant and skips answer eval', async () => {
    const fixtureDir = path.join(repoRoot, 'fixtures', 'rag');
    delete process.env.OPENAI_API_KEY;
    delete process.env.QDRANT_URL;
    delete process.env.RAG_EMBEDDING_PROVIDER;
    process.env.DATA_DIR = path.join(repoRoot, 'data');
    (config as { dataDir: string }).dataDir = originalDataDir;
    let seedSawOfflineProvider = false;
    let dataDirDuringSeed: string | undefined;

    const summary = await runOfflineRagBaseline({
      fixtureDir,
      seedFixtures: async (options) => {
        assert.equal(options.index, true);
        assert.equal(options.embeddingModel, 'deterministic-offline-v1');
        assert.ok(options.embeddingProvider);
        dataDirDuringSeed = config.dataDir;
        seedSawOfflineProvider = true;
        return buildSeedSummary({ fixtureDir });
      },
      runRegression: async (options) => {
        assert.equal(options.includeAnswerEval, false);
        assert.equal(options.embeddingModel, 'deterministic-offline-v1');
        assert.ok(options.embeddingProvider);
        assert.ok(options.vectorStore);
        return {
          itemCount: 1,
          passedItemCount: 1,
          failedItemCount: 0,
          retrievalCaseCount: 10,
          retrievalFailedCount: 0,
          answerCaseCount: 0,
          answerFailedCount: 0,
          passed: true,
          items: [],
        };
      },
    });

    assert.equal(seedSawOfflineProvider, true);
    assert.equal(summary.mode, 'offline');
    assert.equal(summary.passed, true);
    assert.equal(summary.regression.answerCaseCount, 0);
    assert.deepStrictEqual(summary.preflight.missing, []);
    assert.ok(summary.dataDir?.includes(`${path.sep}autorecruit-rag-offline-`));
    assert.equal(dataDirDuringSeed, summary.dataDir);
    assert.equal(config.dataDir, originalDataDir);
    assert.equal(process.env.DATA_DIR, path.join(repoRoot, 'data'));
  });

  it('builds concise offline baseline output for CI logs', () => {
    const summary: RagBaselineSummary = {
      fixtureDir: '/fixtures/rag',
      suiteFile: '/fixtures/rag/regression.json',
      mode: 'offline',
      dataDir: '/tmp/autorecruit-rag-offline-test',
      preflight: {
        embeddingProvider: 'local-http',
        embeddingReady: true,
        qdrantReady: false,
        qdrantReachable: false,
        missing: [],
      },
      seed: buildSeedSummary({
        items: [{
          platform: '51job',
          jobKey: '优衣库',
          filePath: 'fixtures/rag/jobs/51job/优衣库/jd.json',
          status: 'created',
          indexed: {
            platform: '51job',
            jobKey: '优衣库',
            sourceCount: 1,
            chunkCount: 1,
            indexedChunkCount: 1,
            embeddingModel: 'deterministic-offline-v1',
            vectorStore: 'memory',
            manifestPath: '/tmp/manifest.json',
          },
        }],
      }),
      regression: {
        itemCount: 1,
        passedItemCount: 0,
        failedItemCount: 1,
        retrievalCaseCount: 1,
        retrievalFailedCount: 1,
        answerCaseCount: 0,
        answerFailedCount: 0,
        passed: false,
        items: [{
          id: 'baseline',
          platform: '51job',
          jobKey: '优衣库',
          passed: false,
          retrieval: {
            platform: '51job',
            jobKey: '优衣库',
            caseCount: 1,
            passedCount: 0,
            failedCount: 1,
            metrics: { hitRate: 0 },
            cases: [{
              id: 'salary',
              question: '薪资范围是多少？',
              expectNoAnswer: false,
              passed: false,
              checks: {
                expectedTextIncludes: {
                  passed: false,
                  expected: ['税前8-12k'],
                  matched: [],
                  missing: ['税前8-12k'],
                },
              },
              retrieval: {
                denseChunkIds: ['chunk-1'],
                keywordChunkIds: [],
                hybridChunkIds: ['chunk-1'],
                hybridResults: [{
                  chunkId: 'chunk-1',
                  sourceId: 'source-1',
                  sourceType: 'jd',
                  label: 'JD 原文片段 1',
                  score: 0.5,
                  active: true,
                  verified: true,
                  textPreview: '无关内容',
                }],
              },
            }],
          },
        }],
      },
      passed: false,
    };

    const output = buildOfflineRagBaselineCiSummary(summary) as {
      passed: boolean;
      seed: { conversationCount: number; ingestedConversationCount: number };
      regression: { retrievalFailedCount: number; answerCaseCount: number };
      failedRetrievalCases: Array<{
        id?: string;
        failedChecks: Array<{ name: string; missing?: string[] }>;
        hybridResults: Array<{ chunkId: string; sourceType: string }>;
      }>;
    };

    assert.equal(output.passed, false);
    assert.equal(output.seed.conversationCount, 0);
    assert.equal(output.seed.ingestedConversationCount, 0);
    assert.equal(output.regression.retrievalFailedCount, 1);
    assert.equal(output.regression.answerCaseCount, 0);
    assert.equal(output.failedRetrievalCases[0]?.id, 'salary');
    assert.deepStrictEqual(output.failedRetrievalCases[0]?.failedChecks[0]?.missing, ['税前8-12k']);
    assert.deepStrictEqual(output.failedRetrievalCases[0]?.hybridResults[0], {
      chunkId: 'chunk-1',
      sourceType: 'jd',
      score: 0.5,
    });
  });
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  if (originalDataDirEnv === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDirEnv;
  }
  (config as { dataDir: string }).dataDir = originalDataDir;
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  if (originalQdrantUrl === undefined) {
    delete process.env.QDRANT_URL;
  } else {
    process.env.QDRANT_URL = originalQdrantUrl;
  }
  if (originalEmbeddingProvider === undefined) {
    delete process.env.RAG_EMBEDDING_PROVIDER;
  } else {
    process.env.RAG_EMBEDDING_PROVIDER = originalEmbeddingProvider;
  }
  if (originalEmbeddingLocalUrl === undefined) {
    delete process.env.RAG_EMBEDDING_LOCAL_URL;
  } else {
    process.env.RAG_EMBEDDING_LOCAL_URL = originalEmbeddingLocalUrl;
  }
});

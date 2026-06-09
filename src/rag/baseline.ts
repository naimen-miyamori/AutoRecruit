import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { JobStore } from '../storage/job-store.js';
import {
  type RagEmbeddingProvider,
  resolveRagEmbeddingProviderName,
  type RagEmbeddingProviderName,
} from './embeddings.js';
import {
  readRagRegressionSuiteFile,
  runRagRegression,
  type RagRegressionSummary,
  type RunRagRegressionOptions,
} from './regression.js';
import {
  seedRagFixtures,
  type RagFixtureSeedSummary,
  type SeedRagFixturesOptions,
} from './seed-fixtures.js';
import { RagStore } from './rag-store.js';
import { MemoryVectorStore } from './vector-store.js';

export interface RagBaselinePreflightResult {
  embeddingProvider: RagEmbeddingProviderName;
  embeddingReady: boolean;
  qdrantReady: boolean;
  qdrantReachable?: boolean;
  missing: string[];
}

export interface RagBaselineSummary {
  fixtureDir: string;
  suiteFile: string;
  mode: 'online' | 'offline';
  dataDir?: string;
  preflight: RagBaselinePreflightResult;
  seed: RagFixtureSeedSummary;
  regression: RagRegressionSummary;
  passed: boolean;
}

export interface RunRagBaselineOptions {
  fixtureDir?: string;
  suiteFile?: string;
  overwrite?: boolean;
  failOnMissingEnvironment?: boolean;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  checkQdrantAvailability?: boolean;
  checkQdrant?: () => Promise<void>;
  seedFixtures?: (options: SeedRagFixturesOptions) => Promise<RagFixtureSeedSummary>;
  runRegression?: (options: RunRagRegressionOptions) => Promise<RagRegressionSummary>;
}

export interface RunOfflineRagBaselineOptions {
  fixtureDir?: string;
  suiteFile?: string;
  dataDir?: string;
  overwrite?: boolean;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  seedFixtures?: (options: SeedRagFixturesOptions) => Promise<RagFixtureSeedSummary>;
  runRegression?: (options: RunRagRegressionOptions) => Promise<RagRegressionSummary>;
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export function preflightRagBaselineEnvironment(): RagBaselinePreflightResult {
  const embeddingProvider = resolveRagEmbeddingProviderName();
  const missing: string[] = [];

  if (embeddingProvider === 'openai' && !hasEnvValue('OPENAI_API_KEY')) {
    missing.push('OPENAI_API_KEY');
  }

  if (!hasEnvValue('QDRANT_URL')) {
    missing.push('QDRANT_URL');
  }

  return {
    embeddingProvider,
    embeddingReady: embeddingProvider === 'openai'
      ? !missing.includes('OPENAI_API_KEY')
      : true,
    qdrantReady: !missing.includes('QDRANT_URL'),
    missing,
  };
}

function assertPreflightReady(preflight: RagBaselinePreflightResult): void {
  if (preflight.missing.length === 0) {
    return;
  }

  throw new Error(`RAG baseline is missing required environment: ${preflight.missing.join(', ')}`);
}

function resolveQdrantUrl(): string {
  const url = process.env.QDRANT_URL?.trim();
  if (!url) {
    throw new Error('Missing Qdrant configuration: set QDRANT_URL');
  }

  return url.replace(/\/+$/, '');
}

export async function checkQdrantBaselineAvailability(): Promise<void> {
  const url = resolveQdrantUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${url}/collections`, {
      method: 'GET',
      headers: {
        ...(process.env.QDRANT_API_KEY?.trim() ? { 'api-key': process.env.QDRANT_API_KEY.trim() } : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(`${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Qdrant is not reachable at ${url}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runRagBaseline(options: RunRagBaselineOptions = {}): Promise<RagBaselineSummary> {
  const fixtureDir = path.resolve(options.fixtureDir ?? './fixtures/rag');
  const suiteFile = path.resolve(options.suiteFile ?? path.join(fixtureDir, 'regression.json'));
  const preflight = preflightRagBaselineEnvironment();
  if (options.failOnMissingEnvironment !== false) {
    assertPreflightReady(preflight);
  }

  if (options.failOnMissingEnvironment !== false && options.checkQdrantAvailability !== false) {
    const checkQdrant = options.checkQdrant ?? checkQdrantBaselineAvailability;
    await checkQdrant();
    preflight.qdrantReachable = true;
  }

  const seedFixtures = options.seedFixtures ?? seedRagFixtures;
  const seed = await seedFixtures({
    fixtureDir,
    overwrite: options.overwrite,
    index: true,
  });

  const runRegression = options.runRegression ?? runRagRegression;
  const regression = await runRegression({
    suite: await readRagRegressionSuiteFile(suiteFile),
    suiteDir: path.dirname(suiteFile),
    topK: options.topK,
    denseTopK: options.denseTopK,
    keywordTopK: options.keywordTopK,
  });

  return {
    fixtureDir,
    suiteFile,
    mode: 'online',
    preflight,
    seed,
    regression,
    passed: regression.passed,
  };
}

function hashTextToVector(text: string, dimensions = 32): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const normalized = text.toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    vector[index % dimensions] += ((code % 97) + 1) / 97;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

export class DeterministicRagEmbeddingProvider implements RagEmbeddingProvider {
  readonly name = 'local-http';

  async embedTexts(texts: string[], _model: string): Promise<number[][]> {
    return texts.map((text) => hashTextToVector(text));
  }
}

async function resolveOfflineDataDir(dataDir?: string): Promise<string> {
  return path.resolve(dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-offline-')));
}

async function withDataDir<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const originalDataDir = config.dataDir;
  const originalDataDirEnv = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  (config as { dataDir: string }).dataDir = dataDir;

  try {
    return await fn();
  } finally {
    if (originalDataDirEnv === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDirEnv;
    }
    (config as { dataDir: string }).dataDir = originalDataDir;
  }
}

export async function runOfflineRagBaseline(options: RunOfflineRagBaselineOptions = {}): Promise<RagBaselineSummary> {
  const fixtureDir = path.resolve(options.fixtureDir ?? './fixtures/rag');
  const suiteFile = path.resolve(options.suiteFile ?? path.join(fixtureDir, 'regression.json'));
  const dataDir = await resolveOfflineDataDir(options.dataDir);

  return withDataDir(dataDir, async () => {
    const jobStore = new JobStore();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const embeddingProvider = new DeterministicRagEmbeddingProvider();
    const embeddingModel = 'deterministic-offline-v1';
    const seedFixtures = options.seedFixtures ?? seedRagFixtures;
    const seed = await seedFixtures({
      fixtureDir,
      overwrite: options.overwrite,
      index: true,
      jobStore,
      ragStore,
      vectorStore,
      embeddingProvider,
      embeddingModel,
    });
    const runRegression = options.runRegression ?? runRagRegression;
    const regression = await runRegression({
      suite: await readRagRegressionSuiteFile(suiteFile),
      suiteDir: path.dirname(suiteFile),
      topK: options.topK,
      denseTopK: options.denseTopK,
      keywordTopK: options.keywordTopK,
      includeAnswerEval: false,
      embeddingProvider,
      embeddingModel,
      jobStore,
      ragStore,
      vectorStore,
    });

    return {
      fixtureDir,
      suiteFile,
      mode: 'offline',
      dataDir,
      preflight: {
        embeddingProvider: embeddingProvider.name,
        embeddingReady: true,
        qdrantReady: false,
        qdrantReachable: false,
        missing: [],
      },
      seed,
      regression,
      passed: regression.passed,
    };
  });
}

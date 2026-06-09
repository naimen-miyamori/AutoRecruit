import fs from 'node:fs/promises';
import path from 'node:path';
import { runOfflineRagBaseline } from '../rag/baseline.js';
import type { RagBaselineSummary } from '../rag/baseline.js';
import type { RagEvalCaseResult, RagEvalCheckResult } from '../rag/eval.js';

interface Args {
  fixtureDir?: string;
  suiteFile?: string;
  dataDir?: string;
  outputFile?: string;
  summaryOnly: boolean;
  overwrite: boolean;
  failOnMismatch: boolean;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
}

function parseOptionalPositiveInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, flagName: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${flagName} must be true or false`);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg.slice(2), value);
    index += 1;
  }

  return {
    fixtureDir: values.get('fixture-dir'),
    suiteFile: values.get('suite-file'),
    dataDir: values.get('data-dir'),
    outputFile: values.get('output-file'),
    summaryOnly: parseBoolean(values.get('summary-only'), '--summary-only', false),
    overwrite: parseBoolean(values.get('overwrite'), '--overwrite', false),
    failOnMismatch: parseBoolean(values.get('fail-on-mismatch'), '--fail-on-mismatch', true),
    topK: parseOptionalPositiveInteger(values.get('top-k'), '--top-k'),
    denseTopK: parseOptionalPositiveInteger(values.get('dense-top-k'), '--dense-top-k'),
    keywordTopK: parseOptionalPositiveInteger(values.get('keyword-top-k'), '--keyword-top-k'),
  };
}

function collectMissingChecks(checks: RagEvalCaseResult['checks']): Array<{ name: string; check: RagEvalCheckResult }> {
  return Object.entries(checks)
    .filter((entry): entry is [string, RagEvalCheckResult] => Boolean(entry[1]) && entry[1]?.passed === false)
    .map(([name, check]) => ({ name, check }));
}

export function buildOfflineRagBaselineCiSummary(summary: RagBaselineSummary): unknown {
  const failedRetrievalCases = summary.regression.items.flatMap((item) => (
    item.retrieval?.cases
      .filter((testCase) => !testCase.passed)
      .map((testCase) => ({
        itemId: item.id,
        platform: item.platform,
        jobKey: item.jobKey,
        id: testCase.id,
        question: testCase.question,
        failedChecks: collectMissingChecks(testCase.checks).map(({ name, check }) => ({
          name,
          missing: check.missing,
          presentForbidden: check.presentForbidden,
          expected: check.expected,
          forbidden: check.forbidden,
          limit: check.limit,
          actual: check.actual,
        })),
        hybridResults: testCase.retrieval.hybridResults.map((result) => ({
          chunkId: result.chunkId,
          sourceType: result.sourceType,
          score: result.score,
        })),
      })) ?? []
  ));

  return {
    mode: summary.mode,
    passed: summary.passed,
    dataDir: summary.dataDir,
    vectorStore: summary.seed.items[0]?.indexed?.vectorStore,
    embeddingModel: summary.seed.items[0]?.indexed?.embeddingModel,
    seed: {
      jobCount: summary.seed.jobCount,
      indexedCount: summary.seed.indexedCount,
      conversationCount: summary.seed.conversationCount,
      ingestedConversationCount: summary.seed.ingestedConversationCount,
    },
    regression: {
      itemCount: summary.regression.itemCount,
      failedItemCount: summary.regression.failedItemCount,
      retrievalCaseCount: summary.regression.retrievalCaseCount,
      retrievalFailedCount: summary.regression.retrievalFailedCount,
      answerCaseCount: summary.regression.answerCaseCount,
      answerFailedCount: summary.regression.answerFailedCount,
    },
    failedRetrievalCases,
  };
}

async function writeOutputFile(filePath: string, payload: unknown): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runOfflineRagBaseline({
    fixtureDir: args.fixtureDir ? path.resolve(args.fixtureDir) : undefined,
    suiteFile: args.suiteFile ? path.resolve(args.suiteFile) : undefined,
    dataDir: args.dataDir ? path.resolve(args.dataDir) : undefined,
    overwrite: args.overwrite,
    topK: args.topK,
    denseTopK: args.denseTopK,
    keywordTopK: args.keywordTopK,
  });
  const output = args.summaryOnly ? buildOfflineRagBaselineCiSummary(summary) : summary;
  console.log(JSON.stringify(output, null, 2));

  if (args.outputFile) {
    await writeOutputFile(args.outputFile, summary);
  }

  if (args.failOnMismatch && !summary.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

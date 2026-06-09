import fs from 'node:fs/promises';
import path from 'node:path';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { RagAnswerEvalCase } from '../rag/answer-eval.js';
import { ensureAnswerLogId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerLogRecord, RagSourceType } from '../rag/types.js';

export interface RagAnswerEvalExportCase extends RagAnswerEvalCase {
  metadata?: {
    exportedFrom: 'answer-log';
    logId: string;
    logCreatedAt: string;
    confidence?: number;
    draft: boolean;
    expectedTextMode: RagAnswerEvalExpectedTextMode;
    expectedTextNeedsReview: boolean;
    expectedTextReviewNote?: string;
  };
}

export interface RagAnswerEvalExportPayload {
  cases: RagAnswerEvalExportCase[];
}

export interface RagAnswerEvalExportSummary {
  platform: SupportedPlatform;
  jobKey: string;
  outputPath: string;
  logCount: number;
  exportedCount: number;
  skippedCount: number;
  onlyFeedback: boolean;
  includeNoAnswer: boolean;
  expectedTextMode: RagAnswerEvalExpectedTextMode;
  draftCount: number;
  needsReviewCount: number;
  output: RagAnswerEvalExportPayload;
}

export type RagAnswerEvalExpectedTextMode = 'answer' | 'source' | 'hybrid';

interface Args {
  platform: SupportedPlatform;
  jobKey?: string;
  keyword?: string;
  outputPath?: string;
  onlyFeedback: boolean;
  includeNoAnswer: boolean;
  expectedTextMode: RagAnswerEvalExpectedTextMode;
  pretty: boolean;
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

function parseExpectedTextMode(value: string | undefined): RagAnswerEvalExpectedTextMode {
  if (value === undefined || value === 'answer') {
    return 'answer';
  }

  if (value === 'source' || value === 'hybrid') {
    return value;
  }

  throw new Error('--expected-text-mode must be answer, source, or hybrid');
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
    platform: parsePlatformArg(values.get('platform')),
    jobKey: values.get('job-key'),
    keyword: values.get('keyword'),
    outputPath: values.get('output'),
    onlyFeedback: parseBoolean(values.get('only-feedback'), '--only-feedback', true),
    includeNoAnswer: parseBoolean(values.get('include-no-answer'), '--include-no-answer', false),
    expectedTextMode: parseExpectedTextMode(values.get('expected-text-mode')),
    pretty: parseBoolean(values.get('pretty'), '--pretty', true),
  };
}

function uniqueValues<T>(values: Array<T | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))];
}

function shouldExportLog(
  log: RagAnswerLogRecord,
  options: { onlyFeedback: boolean; includeNoAnswer: boolean },
): boolean {
  if (options.onlyFeedback && log.feedback?.correct !== true) {
    return false;
  }

  if (log.answered === false) {
    return options.includeNoAnswer;
  }

  return Boolean(log.answer.trim());
}

function normalizeCandidateText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitCandidateText(value: string): string[] {
  return normalizeCandidateText(value)
    .split(/[。！？!?；;\n\r]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasDigitOrAscii(value: string): boolean {
  return /[0-9A-Za-z]/.test(value);
}

function getMeaningfulTextLength(value: string): number {
  return value.replace(/[^\p{L}\p{N}]/gu, '').length;
}

function sourceTextIsSupportedByAnswer(sourceText: string, answer: string): boolean {
  const normalizedAnswer = normalizeCandidateText(answer);
  const normalizedSourceText = normalizeCandidateText(sourceText);
  if (!normalizedSourceText) {
    return false;
  }

  const comparableSourceTexts = uniqueValues([
    normalizedSourceText,
    ...normalizedSourceText
      .split(/[：:]/u)
      .slice(1)
      .map((item) => item.trim())
      .filter(Boolean),
  ]);
  if (comparableSourceTexts.some((text) => normalizedAnswer.includes(text))) {
    return true;
  }

  const tokens = normalizedSourceText.match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningfulTokens = tokens.filter((token) => token.length >= 2 || hasDigitOrAscii(token));
  if (meaningfulTokens.length === 0) {
    return false;
  }

  const matchedCount = meaningfulTokens.filter((token) => normalizedAnswer.includes(token)).length;
  return matchedCount / meaningfulTokens.length >= 0.6;
}

function getSourceExpectedTextIncludes(log: RagAnswerLogRecord): string[] {
  const candidates = log.sources
    .filter((source) => source.active && (source.sourceType === 'jd' || source.verified))
    .flatMap((source) => splitCandidateText(source.text))
    .filter((text) => getMeaningfulTextLength(text) >= 4 && sourceTextIsSupportedByAnswer(text, log.answer))
    .sort((left, right) => {
      const leftHasDigit = hasDigitOrAscii(left) ? 1 : 0;
      const rightHasDigit = hasDigitOrAscii(right) ? 1 : 0;
      if (rightHasDigit !== leftHasDigit) {
        return rightHasDigit - leftHasDigit;
      }

      return getMeaningfulTextLength(left) - getMeaningfulTextLength(right);
    });

  return uniqueValues(candidates).slice(0, 3);
}

function getExpectedAnswerIncludes(
  log: RagAnswerLogRecord,
  mode: RagAnswerEvalExpectedTextMode,
): { expectedAnswerIncludes: string[]; needsReview: boolean; reviewNote?: string } {
  const answerText = log.answer.trim();
  if (mode === 'answer') {
    return {
      expectedAnswerIncludes: [answerText],
      needsReview: true,
      reviewNote: 'Full answer was exported. Replace it with stable key facts before adding to a long-lived regression suite.',
    };
  }

  const sourceExpectedText = getSourceExpectedTextIncludes(log);
  if (sourceExpectedText.length > 0) {
    return {
      expectedAnswerIncludes: sourceExpectedText,
      needsReview: true,
      reviewNote: 'Source-derived key facts were exported automatically. Review them before promoting the case.',
    };
  }

  if (mode === 'hybrid') {
    return {
      expectedAnswerIncludes: [answerText],
      needsReview: true,
      reviewNote: 'No source sentence could be matched to the answer, so the full answer was used as a fallback.',
    };
  }

  return {
    expectedAnswerIncludes: [answerText],
    needsReview: true,
    reviewNote: 'No source sentence could be matched to the answer. Edit expectedAnswerIncludes manually before use.',
  };
}

function toAnswerEvalCase(
  log: RagAnswerLogRecord,
  options: { expectedTextMode: RagAnswerEvalExpectedTextMode },
): RagAnswerEvalExportCase {
  const logWithId = ensureAnswerLogId(log);
  const sourceTypes = uniqueValues<RagSourceType>(log.sources.map((source) => source.sourceType));
  const chunkIds = uniqueValues(log.sources.map((source) => source.chunkId));
  const conversationIds = uniqueValues(log.sources.map((source) => source.conversationId));
  const base = {
    id: logWithId.logId,
    question: log.question,
    forbiddenAnswerIncludes: undefined,
    expectedSourceTypes: sourceTypes.length > 0 ? sourceTypes : undefined,
    expectedChunkIds: chunkIds.length > 0 ? chunkIds : undefined,
    expectedConversationIds: conversationIds.length > 0 ? conversationIds : undefined,
    metadata: {
      exportedFrom: 'answer-log' as const,
      logId: logWithId.logId,
      logCreatedAt: log.createdAt,
      confidence: log.confidence,
      draft: true,
      expectedTextMode: options.expectedTextMode,
      expectedTextNeedsReview: true,
    },
  };

  if (log.answered === false) {
    return {
      ...base,
      expectNoAnswer: true,
      expectedNoAnswerIncludes: log.noAnswerReason ? ['未说明'] : ['未说明'],
    };
  }

  const expectedText = getExpectedAnswerIncludes(log, options.expectedTextMode);
  return {
    ...base,
    expectedAnswerIncludes: expectedText.expectedAnswerIncludes,
    metadata: {
      ...base.metadata,
      expectedTextNeedsReview: expectedText.needsReview,
      expectedTextReviewNote: expectedText.reviewNote,
    },
  };
}

export function buildAnswerEvalExportPayload(
  logs: RagAnswerLogRecord[],
  options: {
    onlyFeedback?: boolean;
    includeNoAnswer?: boolean;
    expectedTextMode?: RagAnswerEvalExpectedTextMode;
  } = {},
): RagAnswerEvalExportPayload {
  const onlyFeedback = options.onlyFeedback !== false;
  const includeNoAnswer = options.includeNoAnswer === true;
  const expectedTextMode = options.expectedTextMode ?? 'answer';
  return {
    cases: logs
      .filter((log) => shouldExportLog(log, { onlyFeedback, includeNoAnswer }))
      .map((log) => toAnswerEvalCase(log, { expectedTextMode })),
  };
}

export async function exportAnswerEvalFromLogs(options: {
  platform: SupportedPlatform;
  jobKey: string;
  outputPath: string;
  onlyFeedback?: boolean;
  includeNoAnswer?: boolean;
  expectedTextMode?: RagAnswerEvalExpectedTextMode;
  pretty?: boolean;
  ragStore?: RagStore;
}): Promise<RagAnswerEvalExportSummary> {
  const ragStore = options.ragStore ?? new RagStore();
  const onlyFeedback = options.onlyFeedback !== false;
  const includeNoAnswer = options.includeNoAnswer === true;
  const expectedTextMode = options.expectedTextMode ?? 'answer';
  const logs = await ragStore.listAnswerLogs(options.platform, options.jobKey);
  const output = buildAnswerEvalExportPayload(logs, {
    onlyFeedback,
    includeNoAnswer,
    expectedTextMode,
  });
  const outputPath = path.resolve(options.outputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(output, null, options.pretty === false ? 0 : 2)}\n`,
    'utf8',
  );

  return {
    platform: options.platform,
    jobKey: options.jobKey,
    outputPath,
    logCount: logs.length,
    exportedCount: output.cases.length,
    skippedCount: logs.length - output.cases.length,
    onlyFeedback,
    includeNoAnswer,
    expectedTextMode,
    draftCount: output.cases.filter((item) => item.metadata?.draft === true).length,
    needsReviewCount: output.cases.filter((item) => item.metadata?.expectedTextNeedsReview === true).length,
    output,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobKey = args.jobKey ?? (args.keyword ? buildJobKey(args.keyword, '') : undefined);
  if (!jobKey || !args.outputPath) {
    throw new Error('Usage: npm run rag:export-answer-eval -- --platform <platform> --keyword "<keyword>" --output ./rag-answer-eval.json');
  }

  const summary = await exportAnswerEvalFromLogs({
    platform: args.platform,
    jobKey,
    outputPath: args.outputPath,
    onlyFeedback: args.onlyFeedback,
    includeNoAnswer: args.includeNoAnswer,
    expectedTextMode: args.expectedTextMode,
    pretty: args.pretty,
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

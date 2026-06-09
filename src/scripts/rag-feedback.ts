import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { ensureAnswerLogId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import { RAG_ANSWER_FEEDBACK_ERROR_TYPES } from '../rag/types.js';
import type { RagAnswerFeedback, RagAnswerFeedbackErrorType, RagAnswerLogRecord } from '../rag/types.js';

export interface RagFeedbackSummary {
  platform: SupportedPlatform;
  jobKey: string;
  matchedCount: number;
  logId: string;
  question: string;
  createdAt: string;
  feedback: RagAnswerFeedback;
}

interface Args {
  platform: SupportedPlatform;
  jobKey?: string;
  keyword?: string;
  logId?: string;
  createdAt?: string;
  question?: string;
  correct?: boolean;
  errorType?: RagAnswerFeedbackErrorType;
  note?: string;
  reviewer?: string;
}

function parseBoolean(value: string | undefined, flagName: string): boolean | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined) {
    return undefined;
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  throw new Error(`${flagName} must be true or false`);
}

function parseErrorType(value: string | undefined): RagAnswerFeedbackErrorType | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }

  if ((RAG_ANSWER_FEEDBACK_ERROR_TYPES as readonly string[]).includes(trimmed)) {
    return trimmed as RagAnswerFeedbackErrorType;
  }

  throw new Error(`--error-type must be one of: ${RAG_ANSWER_FEEDBACK_ERROR_TYPES.join(', ')}`);
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

    values.set(arg.slice(2), value.trim());
    index += 1;
  }

  return {
    platform: parsePlatformArg(values.get('platform')),
    jobKey: values.get('job-key'),
    keyword: values.get('keyword'),
    logId: values.get('log-id'),
    createdAt: values.get('created-at'),
    question: values.get('question'),
    correct: parseBoolean(values.get('correct'), '--correct'),
    errorType: parseErrorType(values.get('error-type')),
    note: values.get('note'),
    reviewer: values.get('reviewer'),
  };
}

function countSelectors(options: { logId?: string; createdAt?: string; question?: string }): number {
  return [options.logId, options.createdAt, options.question].filter((item) => item !== undefined && item !== '').length;
}

function findMatchingLogs(
  logs: RagAnswerLogRecord[],
  options: { logId?: string; createdAt?: string; question?: string },
): Array<{ index: number; log: RagAnswerLogRecord }> {
  return logs
    .map((log, index) => ({ index, log: ensureAnswerLogId(log) }))
    .filter(({ log }) => {
      if (options.logId !== undefined) {
        if (options.logId === '') {
          return false;
        }
        return log.logId === options.logId;
      }

      if (options.createdAt !== undefined) {
        if (options.createdAt === '') {
          return false;
        }
        return log.createdAt === options.createdAt;
      }

      if (options.question === undefined || options.question === '') {
        return false;
      }
      return log.question === options.question;
    });
}

export async function writeRagFeedback(options: {
  platform: SupportedPlatform;
  jobKey: string;
  logId?: string;
  createdAt?: string;
  question?: string;
  correct: boolean;
  errorType?: RagAnswerFeedbackErrorType;
  note?: string;
  reviewer?: string;
  reviewedAt?: string;
  ragStore?: RagStore;
}): Promise<RagFeedbackSummary> {
  if (countSelectors(options) !== 1) {
    throw new Error('Provide exactly one selector: --log-id, --created-at, or --question');
  }
  const errorType = parseErrorType(options.errorType);
  if (options.correct && errorType !== undefined) {
    throw new Error('--error-type is only valid when --correct false');
  }

  const ragStore = options.ragStore ?? new RagStore();
  const logs = await ragStore.listAnswerLogs(options.platform, options.jobKey);
  const matches = findMatchingLogs(logs, options);

  if (matches.length === 0) {
    throw new Error('No answer log matched the provided selector');
  }

  if (matches.length > 1) {
    throw new Error(`Selector matched ${matches.length} answer logs; use --log-id or --created-at to disambiguate`);
  }

  const match = matches[0];
  if (!match) {
    throw new Error('No answer log matched the provided selector');
  }
  const feedback: RagAnswerFeedback = {
    correct: options.correct,
    errorType,
    note: options.note,
    reviewer: options.reviewer,
    reviewedAt: options.reviewedAt ?? new Date().toISOString(),
  };
  const updatedLog = ensureAnswerLogId({
    ...match.log,
    feedback,
  });
  const updatedLogs = logs.map((log, index) => (index === match.index ? updatedLog : ensureAnswerLogId(log)));
  await ragStore.replaceAnswerLogs(options.platform, options.jobKey, updatedLogs);

  return {
    platform: options.platform,
    jobKey: options.jobKey,
    matchedCount: matches.length,
    logId: updatedLog.logId,
    question: updatedLog.question,
    createdAt: updatedLog.createdAt,
    feedback,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobKey = args.jobKey ?? (args.keyword ? buildJobKey(args.keyword, '') : undefined);
  if (!jobKey || args.correct === undefined) {
    throw new Error('Usage: npm run rag:feedback -- --platform <platform> --keyword "<keyword>" --log-id <logId> --correct true [--error-type wrong_fact] [--note "..."] [--reviewer "..."]');
  }

  const summary = await writeRagFeedback({
    platform: args.platform,
    jobKey,
    logId: args.logId,
    createdAt: args.createdAt,
    question: args.question,
    correct: args.correct,
    errorType: args.errorType,
    note: args.note,
    reviewer: args.reviewer,
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

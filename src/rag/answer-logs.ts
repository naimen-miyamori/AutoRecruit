import { createContentHash } from './chunking.js';
import type { RagAnswerLogRecord } from './types.js';

export type RagAnswerLogRecordWithId = RagAnswerLogRecord & { logId: string };

export function buildAnswerLogId(log: Pick<RagAnswerLogRecord, 'platform' | 'jobKey' | 'createdAt' | 'question'>): string {
  const hash = createContentHash([
    log.platform,
    log.jobKey,
    log.createdAt,
    log.question,
  ].join('\n')).slice(0, 12);
  return `answer-log-${hash}`;
}

export function ensureAnswerLogId(log: RagAnswerLogRecord): RagAnswerLogRecordWithId {
  return {
    ...log,
    logId: log.logId ?? buildAnswerLogId(log),
  };
}

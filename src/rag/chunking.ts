import { createHash } from 'node:crypto';
import type { SupportedPlatform } from '../platforms/types.js';
import type { NormalizedJob } from '../types/job.js';
import type { RagChunk, RagConversationTurn, RagSourceRecord } from './types.js';

const DEFAULT_CHUNK_MAX_CHARS = 700;

export function createContentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function splitLongLine(line: string, maxChars = DEFAULT_CHUNK_MAX_CHARS): string[] {
  if (line.length <= maxChars) {
    return [line];
  }

  const sentences = line
    .split(/(?<=[。；;.!?！？])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += maxChars) {
      chunks.push(line.slice(index, index + maxChars));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitTextIntoChunks(text: string, maxChars = DEFAULT_CHUNK_MAX_CHARS): string[] {
  const lines = normalizeWhitespace(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => splitLongLine(line, maxChars));

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }

    chunks.push(current.join('\n'));
    current = [];
    currentLength = 0;
  };

  for (const line of lines) {
    const nextLength = currentLength + line.length + (current.length > 0 ? 1 : 0);
    if (nextLength > maxChars && current.length > 0) {
      flush();
    }

    current.push(line);
    currentLength += line.length + (current.length > 1 ? 1 : 0);
  }

  flush();
  return chunks;
}

function sanitizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function formatList(label: string, values: string[]): string | undefined {
  const sanitized = sanitizeList(values);
  return sanitized.length > 0 ? `${label}：${sanitized.join('；')}` : undefined;
}

function formatRange(min?: number, max?: number, fallback?: string): string | undefined {
  if (fallback?.trim()) {
    return fallback.trim();
  }

  if (typeof min === 'number' && typeof max === 'number') {
    return `${min}-${max}`;
  }

  if (typeof min === 'number') {
    return `${min}以上`;
  }

  if (typeof max === 'number') {
    return `${max}以内`;
  }

  return undefined;
}

function buildStructuredJobChunkTexts(job?: NormalizedJob): Array<{ key: string; label: string; text: string }> {
  if (!job) {
    return [];
  }

  const overview = [
    `职位：${job.title}`,
    job.department ? `部门：${job.department}` : undefined,
    job.location ? `地点：${job.location}` : undefined,
    job.education ? `学历：${job.education}` : undefined,
    job.experienceYearsMin !== undefined ? `最低经验年限：${job.experienceYearsMin}` : undefined,
    job.salaryRange ? `薪资：${formatRange(job.salaryRange.min, job.salaryRange.max, job.salaryRange.raw)}` : undefined,
    job.ageRange ? `年龄：${formatRange(job.ageRange.min, job.ageRange.max, job.ageRange.raw)}` : undefined,
    formatList('专业', job.majors),
    formatList('语言要求', job.languageRequirements),
    formatList('地域偏好', job.regionPreferences),
    formatList('行业标签', job.industryTags),
  ].filter((item): item is string => Boolean(item));

  const chunks: Array<{ key: string; label: string; text: string }> = [];
  if (overview.length > 0) {
    chunks.push({
      key: 'summary',
      label: '结构化 JD 摘要',
      text: overview.join('\n'),
    });
  }

  const sections: Array<[string, string, string[]]> = [
    ['responsibilities', '岗位职责', job.responsibilities],
    ['hard-requirements', '硬性要求', job.hardRequirements],
    ['preferred-requirements', '优先条件', job.preferredRequirements],
  ];

  for (const [key, label, values] of sections) {
    const sanitized = sanitizeList(values);
    if (sanitized.length === 0) {
      continue;
    }

    chunks.push({
      key,
      label,
      text: sanitized.join('\n'),
    });
  }

  return chunks;
}

export interface BuildJdRagRecordsInput {
  platform: SupportedPlatform;
  jobKey: string;
  rawText: string;
  normalizedJob?: NormalizedJob;
  jdVersion?: string;
  createdAt?: string;
}

export function buildJdRagRecords(input: BuildJdRagRecordsInput): { source: RagSourceRecord; chunks: RagChunk[] } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const jdVersion = input.jdVersion ?? createContentHash(input.rawText).slice(0, 16);
  const sourceId = `jd-${jdVersion}`;
  const chunks: RagChunk[] = [];

  for (const structuredChunk of buildStructuredJobChunkTexts(input.normalizedJob)) {
    const chunkId = `${sourceId}-structured-${structuredChunk.key}`;
    const text = `${structuredChunk.label}\n${structuredChunk.text}`;
    chunks.push({
      platform: input.platform,
      jobKey: input.jobKey,
      chunkId,
      sourceId,
      sourceType: 'jd',
      text,
      active: true,
      verified: true,
      contentHash: createContentHash(text),
      jdVersion,
      createdAt,
      updatedAt: createdAt,
      metadata: {
        label: structuredChunk.label,
        structured: true,
      },
    });
  }

  splitTextIntoChunks(input.rawText).forEach((text, index) => {
    const chunkId = `${sourceId}-raw-${index + 1}`;
    chunks.push({
      platform: input.platform,
      jobKey: input.jobKey,
      chunkId,
      sourceId,
      sourceType: 'jd',
      text,
      active: true,
      verified: true,
      contentHash: createContentHash(text),
      jdVersion,
      createdAt,
      updatedAt: createdAt,
      metadata: {
        label: `JD 原文片段 ${index + 1}`,
        structured: false,
      },
    });
  });

  return {
    source: {
      platform: input.platform,
      jobKey: input.jobKey,
      sourceId,
      sourceType: 'jd',
      title: input.normalizedJob?.title,
      active: true,
      verified: true,
      contentHash: createContentHash(input.rawText),
      jdVersion,
      createdAt,
      updatedAt: createdAt,
    },
    chunks,
  };
}

export interface BuildConversationRagRecordsInput {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
  turns: RagConversationTurn[];
  createdAt?: string;
}

export function buildConversationRagRecords(input: BuildConversationRagRecordsInput): { source: RagSourceRecord; chunks: RagChunk[] } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const sourceId = `conversation-${input.conversationId}`;
  const chunks: RagChunk[] = [];

  input.turns.forEach((turn, index) => {
    const content = normalizeWhitespace(turn.content);
    if (!content) {
      return;
    }

    const verified = turn.verified === true && turn.role === 'recruiter';
    const turnId = turn.id ?? `turn-${index + 1}`;
    const turnCreatedAt = turn.createdAt ?? createdAt;

    splitTextIntoChunks(content).forEach((text, chunkIndex) => {
      const chunkId = `${sourceId}-${turnId}-chunk-${chunkIndex + 1}`;
      chunks.push({
        platform: input.platform,
        jobKey: input.jobKey,
        chunkId,
        sourceId,
        sourceType: 'conversation',
        text,
        active: true,
        verified,
        contentHash: createContentHash(text),
        conversationId: input.conversationId,
        speaker: turn.role,
        turnIds: [turnId],
        createdAt: turnCreatedAt,
        updatedAt: turnCreatedAt,
        metadata: turn.metadata,
      });
    });
  });

  return {
    source: {
      platform: input.platform,
      jobKey: input.jobKey,
      sourceId,
      sourceType: 'conversation',
      active: true,
      verified: chunks.some((chunk) => chunk.verified),
      contentHash: createContentHash(input.turns.map((turn) => `${turn.role}:${turn.content}`).join('\n')),
      conversationId: input.conversationId,
      createdAt,
      updatedAt: createdAt,
    },
    chunks,
  };
}

import { completeJsonTextFromOpenAI } from '../llm/openai-client.js';
import type { NormalizedJob } from '../types/job.js';
import type { RagAnswerSource } from './types.js';

export interface JdRagSource {
  id: string;
  label: string;
  text: string;
  score: number;
  sourceType?: string;
  chunkId?: string;
  verified?: boolean;
}

export interface JdQuestionAnswer {
  answer: string;
  sources: JdRagSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
}

export interface AnswerCandidateQuestionFromJdInput {
  rawJdText: string;
  normalizedJob?: NormalizedJob;
  question: string;
  maxSources?: number;
}

interface JdFragment {
  id: string;
  label: string;
  text: string;
  priority: number;
}

const MAX_FRAGMENT_CHARS = 700;
const DEFAULT_MAX_SOURCES = 6;
const MAX_CONTEXT_CHARS = 3600;

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function splitLongLine(line: string): string[] {
  if (line.length <= MAX_FRAGMENT_CHARS) {
    return [line];
  }

  const sentences = line
    .split(/(?<=[。；;.!?！？])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += MAX_FRAGMENT_CHARS) {
      chunks.push(line.slice(index, index + MAX_FRAGMENT_CHARS));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence;
    if (next.length > MAX_FRAGMENT_CHARS && current) {
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

function splitRawJdIntoFragments(rawJdText: string): JdFragment[] {
  const lines = normalizeWhitespace(rawJdText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap(splitLongLine);

  const fragments: JdFragment[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }

    fragments.push({
      id: `jd-${fragments.length + 1}`,
      label: `JD 原文片段 ${fragments.length + 1}`,
      text: current.join('\n'),
      priority: 1,
    });
    current = [];
    currentLength = 0;
  };

  for (const line of lines) {
    const nextLength = currentLength + line.length + (current.length > 0 ? 1 : 0);
    if (nextLength > MAX_FRAGMENT_CHARS && current.length > 0) {
      flush();
    }

    current.push(line);
    currentLength += line.length + (current.length > 1 ? 1 : 0);
  }

  flush();
  return fragments;
}

function formatList(label: string, values: string[]): string | undefined {
  return values.length > 0 ? `${label}：${values.join('；')}` : undefined;
}

function formatRange(min?: number, max?: number, fallback?: string): string | undefined {
  if (fallback) {
    return fallback;
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

function buildNormalizedJobFragments(job?: NormalizedJob): JdFragment[] {
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

  const fragments: JdFragment[] = [];
  if (overview.length > 0) {
    fragments.push({
      id: 'job-summary',
      label: '结构化 JD 摘要',
      text: overview.join('\n'),
      priority: 1.2,
    });
  }

  const sections: Array<[string, string, string[]]> = [
    ['job-responsibilities', '岗位职责', job.responsibilities],
    ['job-hard-requirements', '硬性要求', job.hardRequirements],
    ['job-preferred-requirements', '优先条件', job.preferredRequirements],
  ];

  for (const [id, label, values] of sections) {
    if (values.length === 0) {
      continue;
    }

    fragments.push({
      id,
      label: `结构化 JD：${label}`,
      text: values.join('\n'),
      priority: 1.15,
    });
  }

  return fragments;
}

function buildQueryTerms(question: string): string[] {
  const normalizedQuestion = normalizeWhitespace(question).toLowerCase();
  const terms = new Set<string>();

  for (const token of normalizedQuestion.match(/[a-z0-9+#.]+/g) ?? []) {
    if (token.length >= 2) {
      terms.add(token);
    }
  }

  for (const sequence of normalizedQuestion.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length <= 2) {
      terms.add(sequence);
      continue;
    }

    for (let size = 2; size <= Math.min(4, sequence.length); size += 1) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        terms.add(sequence.slice(index, index + size));
      }
    }
  }

  return [...terms].filter((term) => ![
    '什么',
    '多少',
    '是否',
    '可以',
    '需要',
    '有没有',
    '怎么样',
    '候选人',
    '请问',
  ].includes(term));
}

function scoreFragment(fragment: JdFragment, terms: string[], question: string): number {
  const text = `${fragment.label}\n${fragment.text}`.toLowerCase();
  const normalizedQuestion = normalizeWhitespace(question).toLowerCase();
  let score = 0;

  if (normalizedQuestion && text.includes(normalizedQuestion)) {
    score += 20;
  }

  for (const term of terms) {
    if (!text.includes(term)) {
      continue;
    }

    score += Math.min(term.length, 4);
  }

  return score * fragment.priority;
}

export function retrieveJdFragments(
  rawJdText: string,
  question: string,
  normalizedJob?: NormalizedJob,
  maxSources = DEFAULT_MAX_SOURCES,
): JdRagSource[] {
  const fragments = [
    ...buildNormalizedJobFragments(normalizedJob),
    ...splitRawJdIntoFragments(rawJdText),
  ];

  if (fragments.length === 0) {
    return [];
  }

  const terms = buildQueryTerms(question);
  const scoredFragments = fragments
    .map((fragment) => ({
      ...fragment,
      score: scoreFragment(fragment, terms, question),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.id.localeCompare(right.id);
    });

  const selected = scoredFragments.some((fragment) => fragment.score > 0)
    ? scoredFragments.filter((fragment) => fragment.score > 0)
    : scoredFragments;

  return selected.slice(0, Math.max(1, maxSources)).map((fragment) => ({
    id: fragment.id,
    label: fragment.label,
    text: truncateText(fragment.text, MAX_FRAGMENT_CHARS),
    score: fragment.score,
  }));
}

function buildContext(sources: JdRagSource[]): string {
  let totalLength = 0;
  const blocks: string[] = [];

  for (const source of sources) {
    const block = `[${source.id}] ${source.label}\n${source.text}`;
    if (totalLength + block.length > MAX_CONTEXT_CHARS && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    totalLength += block.length;
  }

  return blocks.join('\n\n');
}

export function toJdRagSources(sources: RagAnswerSource[]): JdRagSource[] {
  return sources.map((source) => ({
    id: source.id,
    label: source.label,
    text: source.text,
    score: source.score,
    sourceType: source.sourceType,
    chunkId: source.chunkId,
    verified: source.verified,
  }));
}

function cleanAnswerText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export async function answerCandidateQuestionFromJd(input: AnswerCandidateQuestionFromJdInput): Promise<JdQuestionAnswer> {
  const question = input.question.trim();
  if (!question) {
    throw new Error('Candidate question must be a non-empty string');
  }

  if (!input.rawJdText.trim()) {
    throw new Error('JD text must be a non-empty string');
  }

  const sources = retrieveJdFragments(
    input.rawJdText,
    question,
    input.normalizedJob,
    input.maxSources ?? DEFAULT_MAX_SOURCES,
  );

  if (sources.length === 0) {
    throw new Error('No JD context is available for question answering');
  }

  const answerText = await completeJsonTextFromOpenAI({
    featureName: 'JD RAG question answering',
    modelEnvName: 'RAG_MODEL',
    input: [
      `候选人问题：${question}`,
      '',
      '可用 JD 片段：',
      buildContext(sources),
    ].join('\n'),
    instructions: [
      '你是招聘方助手，负责根据招聘 JD 回答候选人关于岗位的问题。',
      '只能使用提供的 JD 片段作答，不要补充或猜测 JD 中没有的信息。',
      '如果片段中没有问题答案，明确说明 JD 中未说明，并建议候选人与招聘方确认。',
      '回答要面向候选人，使用中文，语气专业、自然、简洁。',
      '不要提及 RAG、检索、模型、片段编号或内部流程。',
      '直接输出答案文本，不要输出 JSON、markdown 标题或代码块。',
    ].join('\n'),
    maxOutputTokens: 700,
  });

  return {
    answer: cleanAnswerText(answerText),
    sources,
    answered: true,
    confidence: sources[0]?.score ?? 0,
  };
}

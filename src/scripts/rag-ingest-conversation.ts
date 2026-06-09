import fs from 'node:fs/promises';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import { ingestConversation } from '../rag/service.js';
import type { RagConversationTurn, RagSpeaker } from '../rag/types.js';

interface Args {
  platform: ReturnType<typeof parsePlatformArg>;
  jobKey?: string;
  keyword?: string;
  conversationId?: string;
  conversationFile?: string;
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
    conversationId: values.get('conversation-id'),
    conversationFile: values.get('conversation-file'),
  };
}

function normalizeRole(value: unknown): RagSpeaker {
  if (value === 'candidate' || value === 'recruiter' || value === 'system') {
    return value;
  }

  throw new Error(`Invalid conversation role: ${String(value)}. Expected candidate, recruiter, or system`);
}

function normalizeTurn(value: unknown, index: number): RagConversationTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid conversation item at index ${index}: expected object`);
  }

  const item = value as Record<string, unknown>;
  if (typeof item.content !== 'string' || !item.content.trim()) {
    throw new Error(`Invalid conversation item at index ${index}: content must be a non-empty string`);
  }

  return {
    id: typeof item.id === 'string' ? item.id : undefined,
    role: normalizeRole(item.role),
    content: item.content,
    verified: item.verified === true,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
    metadata: item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? item.metadata as Record<string, unknown>
      : undefined,
  };
}

async function readConversationFile(filePath: string): Promise<RagConversationTurn[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  const payload = trimmed.startsWith('[')
    ? JSON.parse(trimmed) as unknown
    : trimmed.split('\n').map((line) => JSON.parse(line) as unknown);

  if (!Array.isArray(payload)) {
    throw new Error('--conversation-file must contain a JSON array or JSONL rows');
  }

  return payload.map((item, index) => normalizeTurn(item, index));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobKey = args.jobKey ?? (args.keyword ? buildJobKey(args.keyword, '') : undefined);

  if (!jobKey || !args.conversationId || !args.conversationFile) {
    throw new Error('Usage: npm run rag:ingest-conversation -- --platform <platform> --keyword "<keyword>" --conversation-id <id> --conversation-file ./conversation.jsonl');
  }

  const turns = await readConversationFile(args.conversationFile);
  console.log(JSON.stringify(await ingestConversation({
    platform: args.platform,
    jobKey,
    conversationId: args.conversationId,
    turns,
  }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

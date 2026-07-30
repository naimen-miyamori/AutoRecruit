import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config } from '../config.js';

export interface CodexSessionCompletionRequest {
  featureName: string;
  input: string;
  instructions: string;
  maxOutputTokens: number;
  outputSchema?: Record<string, unknown>;
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface CodexAppServerSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  waitForTurn(threadId: string): Promise<string>;
  close(): Promise<void>;
}

const ALLOWED_ITEM_TYPES = new Set([
  'agentMessage',
  'contextCompaction',
  'hookPrompt',
  'plan',
  'reasoning',
  'userMessage',
]);

export function isForbiddenCodexToolItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const type = (item as { type?: unknown }).type;
  return typeof type !== 'string' || !ALLOWED_ITEM_TYPES.has(type);
}

function normalizeOutputSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeOutputSchemaNode);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const node = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalizeOutputSchemaNode(child)]),
  ) as Record<string, unknown>;
  const properties = node.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return node;
  }

  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const normalizedProperties: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties as Record<string, unknown>)) {
    normalizedProperties[key] = required.has(key)
      ? property
      : { anyOf: [property, { type: 'null' }] };
  }

  node.properties = normalizedProperties;
  node.required = Object.keys(normalizedProperties);
  return node;
}

/**
 * Codex structured output requires every object property to be listed as required.
 * Optional TypeScript/Zod fields are therefore represented as required nullable fields.
 */
export function toCodexStrictOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeOutputSchemaNode(schema) as Record<string, unknown>;
}

function removeNullObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeNullObjectProperties);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, removeNullObjectProperties(child)]),
  );
}

function normalizeStructuredOutputText(text: string, outputSchema: Record<string, unknown> | undefined): string {
  if (!outputSchema) return text;

  try {
    return JSON.stringify(removeNullObjectProperties(JSON.parse(text)));
  } catch {
    return text;
  }
}

function getItemText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const typed = item as { type?: unknown; text?: unknown; content?: unknown };
  if (typed.type !== 'agentMessage') {
    return undefined;
  }

  if (typeof typed.text === 'string') {
    return typed.text.trim() || undefined;
  }

  if (Array.isArray(typed.content)) {
    const text = typed.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
    return text || undefined;
  }

  return undefined;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return fallback;
}

class CodexSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    next?.();
  }
}

let semaphore = new CodexSemaphore(config.llm.codexSessionMaxConcurrency);

function getString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getThreadId(result: unknown): string {
  if (!result || typeof result !== 'object') {
    throw new Error('Codex session did not return a thread');
  }

  const thread = (result as { thread?: unknown }).thread;
  if (!thread || typeof thread !== 'object') {
    throw new Error('Codex session did not return a thread');
  }

  return getString((thread as { id?: unknown }).id, '');
}

function makeProviderError(featureName: string, detail: string): Error {
  return new Error(`${featureName} Codex-session request failed: ${detail}`);
}

function createCodexAppServerSession(timeoutMs: number): CodexAppServerSession {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_BASE_URL;
  delete environment.OPENAI_MODEL;

  const child = spawn('codex', [
    'app-server',
    '--stdio',
    '--disable', 'web_search_request',
    '-c', 'mcp_servers={}',
    '-c', 'agents.enabled=false',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: environment,
  }) as ChildProcessWithoutNullStreams;

  let closed = false;
  let requestId = 0;
  let turnComplete: ((value: string) => void) | undefined;
  let turnFailed: ((reason: Error) => void) | undefined;
  let turnText = '';
  let activeThreadId = '';
  const pending = new Map<number, PendingRequest>();
  let stderr = '';

  const rejectAll = (error: Error) => {
    for (const pendingRequest of pending.values()) {
      pendingRequest.reject(error);
    }
    pending.clear();
    turnFailed?.(error);
    turnFailed = undefined;
    turnComplete = undefined;
  };

  const failForToolUse = () => {
    const error = new Error('Codex session attempted a disabled tool');
    if (activeThreadId) {
      try {
        write({ method: 'turn/interrupt', params: { threadId: activeThreadId } });
      } catch {
        // The error below remains authoritative if the process is already gone.
      }
    }
    rejectAll(error);
  };

  const write = (message: JsonRpcMessage) => {
    if (closed || !child.stdin.writable) {
      throw new Error('Codex App Server is not available');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const handleMessage = (message: JsonRpcMessage) => {
    if (typeof message.id === 'number') {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);
      if (message.error) {
        pendingRequest.reject(new Error(getString(message.error.message, 'Codex App Server request failed')));
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = message.params?.item;
      if (isForbiddenCodexToolItem(item)) {
        failForToolUse();
        return;
      }

      const text = getItemText(item);
      if (text) turnText = text;
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const delta = message.params?.delta;
      if (typeof delta === 'string') turnText += delta;
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = message.params?.turn as { status?: unknown; error?: unknown } | undefined;
      const status = getString(turn?.status, 'failed');
      if (status !== 'completed') {
        turnFailed?.(new Error(getErrorMessage(turn?.error, `Codex turn ended with status ${status}`)));
      } else if (turnText.trim()) {
        turnComplete?.(turnText.trim());
      } else {
        turnFailed?.(new Error('Codex session returned empty text output'));
      }
      turnFailed = undefined;
      turnComplete = undefined;
    }
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      handleMessage(JSON.parse(line) as JsonRpcMessage);
    } catch {
      rejectAll(new Error('Codex App Server produced an invalid protocol message'));
    }
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr = `${stderr}${line}\n`.slice(-1000);
  });
  child.once('error', (error) => rejectAll(error));
  child.once('exit', (code) => {
    if (!closed) {
      rejectAll(new Error(`Codex App Server exited (${code ?? 'unknown'}): ${stderr.trim() || 'no diagnostic available'}`));
    }
  });

  const deadline = setTimeout(() => {
    rejectAll(new Error(`Codex session exceeded ${timeoutMs}ms`));
    child.kill();
  }, timeoutMs);

  return {
    request(method, params) {
      const id = requestId;
      requestId += 1;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    waitForTurn(threadId) {
      activeThreadId = threadId;
      return new Promise<string>((resolve, reject) => {
        turnComplete = resolve;
        turnFailed = reject;
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      child.stdin.end();
      child.kill();
    },
  };
}

async function completeTextFromCodexSessionImpl(request: CodexSessionCompletionRequest): Promise<string> {
  const release = await semaphore.acquire();
  const scratchDirectory = await mkdtemp(path.join(tmpdir(), 'autorecruit-codex-session-'));
  const session = createCodexAppServerSession(config.llm.codexSessionTimeoutMs);

  try {
    await session.request('initialize', {
      clientInfo: {
        name: 'autorecruit',
        title: 'Auto Recruit',
        version: '0.1.0',
      },
    });
    session.notify('initialized', {});
    const started = await session.request('thread/start', {
      serviceName: 'autorecruit_llm_route',
      approvalPolicy: 'never',
      cwd: scratchDirectory,
      developerInstructions: [
        'You are a text-completion provider for a local recruitment application.',
        'Answer only from the supplied input and instructions.',
        'Do not use tools, files, shell commands, network, web search, MCP, apps, or agents.',
        `Keep the final response within approximately ${request.maxOutputTokens} tokens.`,
        'Return only the requested final text.',
      ].join(' '),
      ephemeral: true,
      sandbox: 'read-only',
      ...(config.llm.codexSessionModel ? { model: config.llm.codexSessionModel } : {}),
    });
    const threadId = getThreadId(started);
    if (!threadId) {
      throw new Error('Codex session did not return a usable thread ID');
    }

    const turn = session.waitForTurn(threadId);
    await session.request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: `${request.instructions}\n\n${request.input}`,
      }],
      cwd: scratchDirectory,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'readOnly',
        networkAccess: false,
      },
      ...(config.llm.codexSessionModel ? { model: config.llm.codexSessionModel } : {}),
      ...(request.outputSchema ? { outputSchema: toCodexStrictOutputSchema(request.outputSchema) } : {}),
    });
    return normalizeStructuredOutputText(await turn, request.outputSchema);
  } catch (error) {
    throw makeProviderError(request.featureName, getErrorMessage(error, 'unknown error'));
  } finally {
    await session.close();
    await rm(scratchDirectory, { recursive: true, force: true });
    release();
  }
}

export const codexSessionCompletionRef: {
  complete: (request: CodexSessionCompletionRequest) => Promise<string>;
} = {
  complete: completeTextFromCodexSessionImpl,
};

export async function completeTextFromCodexSession(request: CodexSessionCompletionRequest): Promise<string> {
  return codexSessionCompletionRef.complete(request);
}

export function resetCodexSessionConcurrencyForTests(limit: number): void {
  semaphore = new CodexSemaphore(limit);
}

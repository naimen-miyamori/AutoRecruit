import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import type {
  CodexSessionFailureDiagnostic,
  CodexSessionFailureKind,
  CodexSessionPhase,
} from '../types/job.js';

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
  setPhase(phase: CodexSessionPhase): void;
  markTurnRunning(): void;
  wrapError(error: unknown): CodexSessionProviderError;
  close(): Promise<void>;
}

export class CodexSessionProviderError extends Error {
  constructor(
    featureName: string,
    detail: string,
    readonly diagnostic: CodexSessionFailureDiagnostic,
  ) {
    super(`${featureName} Codex-session request failed: ${detail}`);
    this.name = 'CodexSessionProviderError';
  }
}

export function getCodexSessionFailureDiagnostic(error: unknown): CodexSessionFailureDiagnostic | undefined {
  return error instanceof CodexSessionProviderError ? error.diagnostic : undefined;
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

function spawnCodexAppServer(): ChildProcessWithoutNullStreams {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_BASE_URL;
  delete environment.OPENAI_MODEL;

  return spawn('codex', [
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
}

/** Narrow injection seam for protocol lifecycle tests; production always uses the local Codex binary. */
export const codexSessionRuntimeRef: {
  spawn: () => ChildProcessWithoutNullStreams;
  connectTimeoutMs: () => number;
  now: () => number;
} = {
  spawn: spawnCodexAppServer,
  connectTimeoutMs: () => config.llm.codexSessionConnectTimeoutMs,
  now: () => Date.now(),
};

function createCodexAppServerSession(featureName: string, connectTimeoutMs: number): CodexAppServerSession {
  const child = codexSessionRuntimeRef.spawn();

  let closed = false;
  let terminal = false;
  let requestId = 0;
  let turnComplete: ((value: string) => void) | undefined;
  let turnFailed: ((reason: Error) => void) | undefined;
  let turnText = '';
  let activeThreadId = '';
  const pending = new Map<number, PendingRequest>();
  let stderr = '';
  const startedAtMs = codexSessionRuntimeRef.now();
  let phase: CodexSessionPhase = 'process-starting';
  let firstOutputObserved = false;
  let lastProtocolActivityAt: string | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;

  const clearConnectionTimer = () => {
    if (connectionTimer) clearTimeout(connectionTimer);
    connectionTimer = undefined;
  };

  const diagnostic = (
    kind: CodexSessionFailureKind,
    retryable: boolean,
  ): CodexSessionFailureDiagnostic => ({
    provider: 'codex-session',
    kind,
    phase,
    retryable,
    firstOutputObserved,
    elapsedMs: Math.max(0, codexSessionRuntimeRef.now() - startedAtMs),
    occurredAt: new Date(codexSessionRuntimeRef.now()).toISOString(),
    ...(lastProtocolActivityAt ? { lastProtocolActivityAt } : {}),
  });

  const providerError = (
    kind: CodexSessionFailureKind,
    detail: string,
    retryable = true,
  ) => new CodexSessionProviderError(featureName, detail, diagnostic(kind, retryable));

  const rejectAll = (error: Error) => {
    if (terminal) return;
    terminal = true;
    clearConnectionTimer();
    for (const pendingRequest of pending.values()) {
      pendingRequest.reject(error);
    }
    pending.clear();
    turnFailed?.(error);
    turnFailed = undefined;
    turnComplete = undefined;
  };

  const armConnectionTimer = () => {
    clearConnectionTimer();
    if (closed || terminal || phase === 'turn-running' || phase === 'completed') return;
    connectionTimer = setTimeout(() => {
      rejectAll(providerError(
        'connection-timeout',
        `Codex App Server did not complete phase ${phase} within ${connectTimeoutMs}ms`,
      ));
      child.kill();
    }, connectTimeoutMs);
  };

  const setPhase = (nextPhase: CodexSessionPhase) => {
    if (phase === 'completed' || terminal) return;
    phase = nextPhase;
    armConnectionTimer();
  };

  const markTurnRunning = () => {
    if (phase === 'completed' || terminal) return;
    phase = 'turn-running';
    clearConnectionTimer();
  };

  const failForToolUse = () => {
    const error = providerError('policy-violation', 'Codex session attempted a disabled tool', false);
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
      throw providerError('process-error', 'Codex App Server is not available');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const handleMessage = (message: JsonRpcMessage) => {
    lastProtocolActivityAt = new Date(codexSessionRuntimeRef.now()).toISOString();

    if (message.method === 'turn/started') {
      markTurnRunning();
      return;
    }

    if (typeof message.id === 'number') {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);
      // A response completes this handshake phase. The caller immediately
      // advances to the next phase (or marks the turn running); unrelated
      // notifications must never extend the phase's absolute timeout.
      clearConnectionTimer();
      if (message.error) {
        pendingRequest.reject(providerError(
          'request-error',
          getString(message.error.message, 'Codex App Server request failed'),
        ));
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      markTurnRunning();
      const item = message.params?.item;
      if (isForbiddenCodexToolItem(item)) {
        failForToolUse();
        return;
      }

      const text = getItemText(item);
      if (text) {
        firstOutputObserved = true;
        turnText = text;
      }
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      markTurnRunning();
      const delta = message.params?.delta;
      if (typeof delta === 'string') {
        firstOutputObserved = firstOutputObserved || delta.length > 0;
        turnText += delta;
      }
      return;
    }

    if (message.method === 'turn/completed') {
      markTurnRunning();
      const turn = message.params?.turn as { status?: unknown; error?: unknown } | undefined;
      const status = getString(turn?.status, 'failed');
      if (status !== 'completed') {
        turnFailed?.(providerError(
          'turn-failed',
          getErrorMessage(turn?.error, `Codex turn ended with status ${status}`),
        ));
      } else if (turnText.trim()) {
        turnComplete?.(turnText.trim());
      } else {
        turnFailed?.(providerError('empty-output', 'Codex session returned empty text output'));
      }
      turnFailed = undefined;
      turnComplete = undefined;
      phase = 'completed';
      clearConnectionTimer();
    }
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      handleMessage(JSON.parse(line) as JsonRpcMessage);
    } catch {
      rejectAll(providerError('protocol-error', 'Codex App Server produced an invalid protocol message'));
    }
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr = `${stderr}${line}\n`.slice(-1000);
  });
  child.once('error', (error) => rejectAll(providerError('process-error', error.message)));
  child.once('exit', (code) => {
    if (!closed) {
      const kind: CodexSessionFailureKind = phase === 'turn-running'
        ? 'turn-interrupted'
        : 'process-exit';
      rejectAll(providerError(
        kind,
        `Codex App Server exited (${code ?? 'unknown'}): ${stderr.trim() || 'no diagnostic available'}`,
      ));
    }
  });

  armConnectionTimer();

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
          reject(error instanceof CodexSessionProviderError
            ? error
            : providerError('process-error', getErrorMessage(error, 'Codex App Server write failed')));
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
    setPhase,
    markTurnRunning,
    wrapError(error) {
      return error instanceof CodexSessionProviderError
        ? error
        : providerError('request-error', getErrorMessage(error, 'unknown error'));
    },
    async close() {
      if (closed) return;
      closed = true;
      clearConnectionTimer();
      child.stdin.end();
      child.kill();
    },
  };
}

async function completeTextFromCodexSessionImpl(request: CodexSessionCompletionRequest): Promise<string> {
  const release = await semaphore.acquire();
  const scratchDirectory = await mkdtemp(path.join(tmpdir(), 'autorecruit-codex-session-'));
  const session = createCodexAppServerSession(request.featureName, codexSessionRuntimeRef.connectTimeoutMs());

  try {
    session.setPhase('initializing');
    await session.request('initialize', {
      clientInfo: {
        name: 'autorecruit',
        title: 'Auto Recruit',
        version: '0.1.0',
      },
    });
    session.notify('initialized', {});
    session.setPhase('thread-starting');
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

    session.setPhase('turn-starting');
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
    // The request acknowledgement is sufficient evidence that the turn is in
    // progress. Once here there is deliberately no wall-clock model timeout;
    // only explicit protocol/process outcomes can end the operation.
    session.markTurnRunning();
    return normalizeStructuredOutputText(await turn, request.outputSchema);
  } catch (error) {
    throw session.wrapError(error);
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

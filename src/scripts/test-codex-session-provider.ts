import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  CodexSessionProviderError,
  codexSessionRuntimeRef,
  completeTextFromCodexSession,
  isForbiddenCodexToolItem,
  resetCodexSessionConcurrencyForTests,
  toCodexStrictOutputSchema,
} from '../llm/codex-session-provider.js';

interface FakeRequest {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function createFakeCodexProcess(
  onRequest: (
    request: FakeRequest,
    controls: {
      respond(id: number, result: unknown): void;
      notify(method: string, params: Record<string, unknown>): void;
      exit(code: number): void;
    },
  ) => void,
): { child: ChildProcessWithoutNullStreams; wasKilled: () => boolean } {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    stdout.end();
    stderr.end();
    events.emit('exit', code);
  };
  const controls = {
    respond(id: number, result: unknown) {
      stdout.write(`${JSON.stringify({ id, result })}\n`);
    },
    notify(method: string, params: Record<string, unknown>) {
      stdout.write(`${JSON.stringify({ method, params })}\n`);
    },
    exit(code: number) {
      finish(code);
    },
  };
  createInterface({ input: stdin }).on('line', (line) => {
    onRequest(JSON.parse(line) as FakeRequest, controls);
  });
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill() {
      killed = true;
      finish(0);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(() => events.emit('spawn'));
  return { child, wasKilled: () => killed };
}

async function withFakeCodexRuntime<T>(
  fake: ReturnType<typeof createFakeCodexProcess>,
  connectTimeoutMs: number,
  action: () => Promise<T>,
): Promise<T> {
  const original = { ...codexSessionRuntimeRef };
  codexSessionRuntimeRef.spawn = () => fake.child;
  codexSessionRuntimeRef.connectTimeoutMs = () => connectTimeoutMs;
  codexSessionRuntimeRef.now = () => Date.now();
  resetCodexSessionConcurrencyForTests(1);
  try {
    return await action();
  } finally {
    Object.assign(codexSessionRuntimeRef, original);
    resetCodexSessionConcurrencyForTests(1);
  }
}

describe('Codex session provider tool isolation', () => {
  it('blocks every executable, external, or unknown item type', () => {
    for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'imageView', 'sleep', 'imageGeneration', 'unknown']) {
      assert.equal(isForbiddenCodexToolItem({ type }), true, type);
    }
  });

  it('allows only non-tool lifecycle items through the completion stream', () => {
    assert.equal(isForbiddenCodexToolItem({ type: 'agentMessage', text: '{"ok":true}' }), false);
    assert.equal(isForbiddenCodexToolItem({ type: 'reasoning' }), false);
    assert.equal(isForbiddenCodexToolItem({ type: 'plan' }), false);
    assert.equal(isForbiddenCodexToolItem(undefined), false);
  });

  it('converts optional object properties to the strict nullable output form', () => {
    assert.deepEqual(toCodexStrictOutputSchema({
      type: 'object',
      properties: {
        requiredValue: { type: 'string' },
        optionalValue: { type: 'number' },
      },
      required: ['requiredValue'],
    }), {
      type: 'object',
      properties: {
        requiredValue: { type: 'string' },
        optionalValue: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['requiredValue', 'optionalValue'],
    });
  });

  it('does not apply the connection timeout after a turn has started', async () => {
    const fake = createFakeCodexProcess((request, controls) => {
      if (request.id === undefined) return;
      if (request.method === 'initialize') controls.respond(request.id, {});
      if (request.method === 'thread/start') controls.respond(request.id, { thread: { id: 'thread-long-turn' } });
      if (request.method === 'turn/start') {
        controls.respond(request.id, { turn: { id: 'turn-long' } });
        controls.notify('turn/started', { turn: { id: 'turn-long' } });
        setTimeout(() => {
          controls.notify('item/agentMessage/delta', { delta: '{"ok":true}' });
          controls.notify('turn/completed', { turn: { status: 'completed' } });
        }, 50);
      }
    });

    const output = await withFakeCodexRuntime(fake, 10, () => completeTextFromCodexSession({
      featureName: 'long-turn-test',
      input: 'fixed test input',
      instructions: 'return json',
      maxOutputTokens: 20,
    }));

    assert.equal(output, '{"ok":true}');
    assert.equal(fake.wasKilled(), true, 'normal close should terminate the ephemeral app-server only after completion');
  });

  it('classifies an initialize handshake timeout separately from model processing', async () => {
    const fake = createFakeCodexProcess(() => undefined);
    await withFakeCodexRuntime(fake, 10, async () => {
      await assert.rejects(
        completeTextFromCodexSession({
          featureName: 'connect-timeout-test',
          input: 'fixed test input',
          instructions: 'return json',
          maxOutputTokens: 20,
        }),
        (error) => {
          assert.ok(error instanceof CodexSessionProviderError);
          assert.equal(error.diagnostic.kind, 'connection-timeout');
          assert.equal(error.diagnostic.phase, 'initializing');
          assert.equal(error.diagnostic.firstOutputObserved, false);
          assert.equal(error.diagnostic.retryable, true);
          return true;
        },
      );
    });
    assert.equal(fake.wasKilled(), true);
  });

  it('keeps each handshake timeout absolute despite unrelated protocol activity', async () => {
    const fake = createFakeCodexProcess((request, controls) => {
      if (request.method !== 'initialize') return;
      const noise = setInterval(() => controls.notify('server/heartbeat', {}), 3);
      setTimeout(() => clearInterval(noise), 80);
    });

    const startedAt = Date.now();
    await withFakeCodexRuntime(fake, 12, async () => {
      await assert.rejects(
        completeTextFromCodexSession({
          featureName: 'absolute-connect-timeout-test',
          input: 'fixed test input',
          instructions: 'return json',
          maxOutputTokens: 20,
        }),
        (error) => {
          assert.ok(error instanceof CodexSessionProviderError);
          assert.equal(error.diagnostic.kind, 'connection-timeout');
          assert.equal(error.diagnostic.phase, 'initializing');
          assert.ok(error.diagnostic.lastProtocolActivityAt);
          return true;
        },
      );
    });
    assert.ok(Date.now() - startedAt < 60, 'heartbeat notifications must not restart the phase timer');
  });

  it('records an active turn interruption and whether output had started', async () => {
    const fake = createFakeCodexProcess((request, controls) => {
      if (request.id === undefined) return;
      if (request.method === 'initialize') controls.respond(request.id, {});
      if (request.method === 'thread/start') controls.respond(request.id, { thread: { id: 'thread-interrupted' } });
      if (request.method === 'turn/start') {
        controls.respond(request.id, { turn: { id: 'turn-interrupted' } });
        controls.notify('turn/started', { turn: { id: 'turn-interrupted' } });
        controls.notify('item/agentMessage/delta', { delta: '{' });
        setTimeout(() => controls.exit(9), 5);
      }
    });

    await withFakeCodexRuntime(fake, 20, async () => {
      await assert.rejects(
        completeTextFromCodexSession({
          featureName: 'turn-interruption-test',
          input: 'fixed test input',
          instructions: 'return json',
          maxOutputTokens: 20,
        }),
        (error) => {
          assert.ok(error instanceof CodexSessionProviderError);
          assert.equal(error.diagnostic.kind, 'turn-interrupted');
          assert.equal(error.diagnostic.phase, 'turn-running');
          assert.equal(error.diagnostic.firstOutputObserved, true);
          return true;
        },
      );
    });
  });
});

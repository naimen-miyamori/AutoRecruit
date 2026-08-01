import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, describe, it } from 'node:test';
import { completeJsonTextFromOpenAI, llmCompletionRouteRef } from '../llm/openai-client.js';
import { codexSessionCompletionRef } from '../llm/codex-session-provider.js';
import {
  describeScoringModel,
  resolveLlmCompletionRoute,
  resolveScoringLlmCompletionRoute,
} from '../config.js';

interface RecordedRequest {
  method?: string;
  url?: string;
  body: unknown;
}

const servers: http.Server[] = [];
const initialRouteResolver = llmCompletionRouteRef.current;
const initialCodexCompletion = codexSessionCompletionRef.complete;

afterEach(() => {
  llmCompletionRouteRef.current = initialRouteResolver;
  codexSessionCompletionRef.complete = initialCodexCompletion;
});

async function readRequestJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : undefined;
}

async function startMockOpenAIServer(recordedRequests: RecordedRequest[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const body = await readRequestJson(request);
    recordedRequests.push({
      method: request.method,
      url: request.url,
      body,
    });

    if (request.url === '/v1/responses') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Your request was blocked.' } }));
      return;
    }

    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '{"ok":true}',
            },
            finish_reason: 'stop',
          },
        ],
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('completeJsonTextFromOpenAI', () => {
  it('falls back to chat completions when the responses endpoint is blocked', async () => {
    const recordedRequests: RecordedRequest[] = [];
    const server = await startMockOpenAIServer(recordedRequests);

    try {
      const output = await completeJsonTextFromOpenAI({
        featureName: 'llm test',
        modelEnvName: 'OPENAI_MODEL',
        completionRoute: 'default',
        input: 'Return JSON.',
        instructions: 'Only JSON.',
        maxOutputTokens: 50,
        settings: {
          apiKey: 'test-key',
          baseUrl: server.baseUrl,
          model: 'test-model',
        },
      });

      assert.equal(output, '{"ok":true}');
      assert.deepEqual(
        recordedRequests.map((request) => request.url),
        ['/v1/responses', '/v1/chat/completions'],
      );
      assert.deepEqual(recordedRequests[1]?.body, {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'Only JSON.' },
          { role: 'user', content: 'Return JSON.' },
        ],
        max_tokens: 50,
      });
    } finally {
      await server.close();
    }
  });

  it('uses only the explicit codex-session route and does not require default-service credentials', async () => {
    let receivedRequest: unknown;
    llmCompletionRouteRef.current = () => 'codex-session';
    codexSessionCompletionRef.complete = async (request) => {
      receivedRequest = request;
      return '{"ok":true}';
    };

    const output = await completeJsonTextFromOpenAI({
      featureName: 'codex route test',
      modelEnvName: 'OPENAI_MODEL',
      input: 'Return JSON.',
      instructions: 'Only JSON.',
      maxOutputTokens: 50,
      outputSchema: { type: 'object' },
    });

    assert.equal(output, '{"ok":true}');
    assert.deepEqual(receivedRequest, {
      featureName: 'codex route test',
      input: 'Return JSON.',
      instructions: 'Only JSON.',
      maxOutputTokens: 50,
      outputSchema: { type: 'object' },
    });
  });

  it('rejects request-level provider overrides in codex-session mode', async () => {
    let called = false;
    llmCompletionRouteRef.current = () => 'codex-session';
    codexSessionCompletionRef.complete = async () => {
      called = true;
      return '{}';
    };

    await assert.rejects(
      completeJsonTextFromOpenAI({
        featureName: 'codex route test',
        modelEnvName: 'OPENAI_MODEL',
        input: 'Return JSON.',
        instructions: 'Only JSON.',
        maxOutputTokens: 50,
        settings: { model: 'other-model' },
      }),
      /cannot use request-level model settings when completionRoute=codex-session/,
    );
    assert.equal(called, false);
  });

  it('uses an explicit feature route independently of the global route', async () => {
    let codexRequests = 0;
    llmCompletionRouteRef.current = () => 'default';
    codexSessionCompletionRef.complete = async () => {
      codexRequests += 1;
      return '{"provider":"codex"}';
    };

    const codexOutput = await completeJsonTextFromOpenAI({
      featureName: 'feature route test',
      modelEnvName: 'SCORING_MODEL',
      completionRoute: 'codex-session',
      input: 'Return JSON.',
      instructions: 'Only JSON.',
      maxOutputTokens: 50,
    });
    assert.equal(codexOutput, '{"provider":"codex"}');
    assert.equal(codexRequests, 1);

    const recordedRequests: RecordedRequest[] = [];
    const server = await startMockOpenAIServer(recordedRequests);
    llmCompletionRouteRef.current = () => 'codex-session';
    try {
      const defaultOutput = await completeJsonTextFromOpenAI({
        featureName: 'feature route test',
        modelEnvName: 'SCORING_MODEL',
        completionRoute: 'default',
        input: 'Return JSON.',
        instructions: 'Only JSON.',
        maxOutputTokens: 50,
        settings: {
          apiKey: 'test-key',
          baseUrl: server.baseUrl,
          model: 'test-model',
        },
      });
      assert.equal(defaultOutput, '{"ok":true}');
      assert.equal(codexRequests, 1);
    } finally {
      await server.close();
    }
  });
});

describe('LLM completion route configuration', () => {
  it('accepts only the two explicit routes', () => {
    assert.equal(resolveLlmCompletionRoute('default'), 'default');
    assert.equal(resolveLlmCompletionRoute(' CODEX-SESSION '), 'codex-session');
    assert.throws(() => resolveLlmCompletionRoute('auto'), /must be either "default" or "codex-session"/);
  });

  it('defaults only resume scoring to codex-session and describes its actual provider', () => {
    assert.equal(resolveScoringLlmCompletionRoute(''), 'codex-session');
    assert.equal(resolveScoringLlmCompletionRoute(' DEFAULT '), 'default');
    assert.throws(
      () => resolveScoringLlmCompletionRoute('auto'),
      /SCORING_LLM_COMPLETION_ROUTE must be either "default" or "codex-session"/,
    );
    assert.equal(describeScoringModel('codex-session', {}), 'codex-session:account-default');
    assert.equal(
      describeScoringModel('codex-session', { codexSessionModel: ' session-model ' }),
      'codex-session:session-model',
    );
    assert.equal(
      describeScoringModel('default', { openAIModel: ' scoring-api-model ' }),
      'scoring-api-model',
    );
    assert.equal(describeScoringModel('default', {}), 'openai-compatible:unconfigured');
  });
});

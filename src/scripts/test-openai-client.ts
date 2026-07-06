import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';
import { completeJsonTextFromOpenAI } from '../llm/openai-client.js';

interface RecordedRequest {
  method?: string;
  url?: string;
  body: unknown;
}

const servers: http.Server[] = [];

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
});

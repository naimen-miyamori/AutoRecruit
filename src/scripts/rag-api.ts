import http from 'node:http';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  answerQuestionWithRag,
  ingestConversation,
  type AskRagQuestionOptions,
  type IngestConversationOptions,
} from '../rag/service.js';
import type { RagAnswer, RagConversationTurn, RagSpeaker } from '../rag/types.js';

type JsonObject = Record<string, unknown>;

export interface RagApiConfig {
  host: string;
  port: number;
  apiKey?: string;
  maxBodyBytes: number;
}

export interface RagApiResponse<T = unknown> {
  statusCode: number;
  body: T;
}

interface Args {
  host?: string;
  port?: number;
  apiKey?: string;
  maxBodyBytes?: number;
}

function parseOptionalPositiveInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
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
    host: values.get('host'),
    port: parseOptionalPositiveInteger(values.get('port'), '--port'),
    apiKey: values.get('api-key'),
    maxBodyBytes: parseOptionalPositiveInteger(values.get('max-body-bytes'), '--max-body-bytes'),
  };
}

export function resolveRagApiConfig(overrides: Partial<RagApiConfig> = {}): RagApiConfig {
  const apiKey = overrides.apiKey ?? process.env.RAG_API_KEY?.trim();
  return {
    host: overrides.host ?? process.env.RAG_API_HOST?.trim() ?? '127.0.0.1',
    port: overrides.port ?? parseOptionalPositiveInteger(process.env.RAG_API_PORT?.trim(), 'RAG_API_PORT') ?? 3978,
    apiKey: apiKey || undefined,
    maxBodyBytes: overrides.maxBodyBytes ?? parseOptionalPositiveInteger(process.env.RAG_API_MAX_BODY_BYTES?.trim(), 'RAG_API_MAX_BODY_BYTES') ?? 1024 * 1024,
  };
}

function jsonResponse<T>(statusCode: number, body: T): RagApiResponse<T> {
  return { statusCode, body };
}

function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value as JsonObject;
}

function getOptionalString(item: JsonObject, fieldName: string): string | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string when provided`);
  }

  return value.trim();
}

function getRequiredString(item: JsonObject, fieldName: string): string {
  const value = getOptionalString(item, fieldName);
  if (!value) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function normalizePlatform(value: unknown): SupportedPlatform {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('platform is required');
  }

  return parsePlatformArg(value.trim());
}

function resolveRequestJobKey(item: JsonObject): string {
  const jobKey = getOptionalString(item, 'jobKey');
  if (jobKey) {
    return jobKey;
  }

  const keyword = getOptionalString(item, 'keyword');
  if (keyword) {
    return buildJobKey(keyword, '');
  }

  throw new Error('jobKey or keyword is required');
}

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value;
}

function normalizeBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

function normalizeMetadata(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object when provided`);
  }

  return value as Record<string, unknown>;
}

function normalizeRole(value: unknown, fieldPath: string): RagSpeaker {
  if (value === 'candidate' || value === 'recruiter' || value === 'system') {
    return value;
  }

  throw new Error(`${fieldPath}.role must be candidate, recruiter, or system`);
}

function normalizeTurn(value: unknown, index: number): RagConversationTurn {
  const item = normalizeJsonObject(value, `turns[${index}]`);
  return {
    id: getOptionalString(item, 'id'),
    role: normalizeRole(item.role, `turns[${index}]`),
    content: getRequiredString(item, 'content'),
    verified: item.verified === true,
    createdAt: getOptionalString(item, 'createdAt'),
    metadata: normalizeMetadata(item.metadata, `turns[${index}].metadata`),
  };
}

function normalizeTurns(value: unknown): RagConversationTurn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('turns must be a non-empty array');
  }

  return value.map((turn, index) => normalizeTurn(turn, index));
}

function normalizeAskRequest(payload: unknown): AskRagQuestionOptions {
  const item = normalizeJsonObject(payload, 'request body');
  return {
    platform: normalizePlatform(item.platform),
    jobKey: resolveRequestJobKey(item),
    question: getRequiredString(item, 'question'),
    topK: normalizePositiveInteger(item.topK, 'topK'),
    autoIndex: normalizeBoolean(item.autoIndex, 'autoIndex'),
    logAnswer: normalizeBoolean(item.logAnswer, 'logAnswer'),
    answerLogMetadata: normalizeMetadata(item.metadata, 'metadata'),
  };
}

function normalizeIngestRequest(payload: unknown): IngestConversationOptions {
  const item = normalizeJsonObject(payload, 'request body');
  return {
    platform: normalizePlatform(item.platform),
    jobKey: resolveRequestJobKey(item),
    conversationId: getRequiredString(item, 'conversationId'),
    turns: normalizeTurns(item.turns),
  };
}

function toPublicRagAnswer(answer: RagAnswer): RagAnswer {
  return {
    ...answer,
    sources: answer.sources.map((source) => ({
      ...source,
      text: source.text,
    })),
  };
}

function isAuthorized(headers: http.IncomingHttpHeaders, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }

  const authorization = headers.authorization;
  return authorization === `Bearer ${apiKey}`;
}

function readRequestBody(request: http.IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        reject(new Error(`Request body exceeds ${maxBodyBytes} bytes`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8').trim();
      if (!rawBody) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(rawBody) as unknown);
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

export async function handleRagApiRequest(options: {
  method: string;
  pathname: string;
  headers?: http.IncomingHttpHeaders;
  body?: unknown;
  config?: Partial<RagApiConfig>;
  answerQuestion?: (options: AskRagQuestionOptions) => Promise<RagAnswer>;
  ingestConversationFn?: (options: IngestConversationOptions) => Promise<unknown>;
}): Promise<RagApiResponse> {
  const config = resolveRagApiConfig(options.config);
  const headers = options.headers ?? {};

  if (!isAuthorized(headers, config.apiKey)) {
    return jsonResponse(401, {
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid bearer token',
      },
    });
  }

  try {
    if (options.method === 'GET' && options.pathname === '/health') {
      return jsonResponse(200, {
        status: 'ok',
        service: 'rag-api',
      });
    }

    if (options.method === 'POST' && options.pathname === '/v1/rag/answer') {
      const requestOptions = normalizeAskRequest(options.body);
      const answerQuestion = options.answerQuestion ?? answerQuestionWithRag;
      const answer = await answerQuestion(requestOptions);
      return jsonResponse(200, {
        platform: requestOptions.platform,
        jobKey: requestOptions.jobKey,
        question: requestOptions.question,
        ...toPublicRagAnswer(answer),
      });
    }

    if (options.method === 'POST' && options.pathname === '/v1/rag/conversations') {
      const requestOptions = normalizeIngestRequest(options.body);
      const ingestConversationFn = options.ingestConversationFn ?? ingestConversation;
      const summary = await ingestConversationFn(requestOptions);
      return jsonResponse(200, {
        platform: requestOptions.platform,
        jobKey: requestOptions.jobKey,
        conversationId: requestOptions.conversationId,
        turnCount: requestOptions.turns.length,
        verifiedTurnCount: requestOptions.turns.filter((turn) => turn.role === 'recruiter' && turn.verified === true).length,
        summary,
      });
    }

    return jsonResponse(404, {
      error: {
        code: 'not_found',
        message: `No route for ${options.method} ${options.pathname}`,
      },
    });
  } catch (error) {
    return jsonResponse(400, {
      error: {
        code: 'bad_request',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function writeJson(response: http.ServerResponse, result: RagApiResponse): void {
  response.writeHead(result.statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(result.body, null, 2)}\n`);
}

export function createRagApiServer(config: RagApiConfig): http.Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
    try {
      const body = request.method === 'GET'
        ? undefined
        : await readRequestBody(request, config.maxBodyBytes);
      writeJson(response, await handleRagApiRequest({
        method: request.method ?? 'GET',
        pathname: url.pathname,
        headers: request.headers,
        body,
        config,
      }));
    } catch (error) {
      writeJson(response, jsonResponse(400, {
        error: {
          code: 'bad_request',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveRagApiConfig({
    host: args.host,
    port: args.port,
    apiKey: args.apiKey,
    maxBodyBytes: args.maxBodyBytes,
  });
  const server = createRagApiServer(config);

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(JSON.stringify({
    service: 'rag-api',
    host: config.host,
    port: config.port,
    auth: config.apiKey ? 'bearer' : 'none',
    endpoints: [
      'GET /health',
      'POST /v1/rag/answer',
      'POST /v1/rag/conversations',
    ],
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

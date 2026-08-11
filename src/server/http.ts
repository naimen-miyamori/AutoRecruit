import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest, type ApiResponse } from './routes.js';
import { JobReadModel } from './job-read-model.js';
import { TaskScheduler } from './task-scheduler.js';
import { TaskQueue } from './task-queue.js';

export interface ConsoleApiConfig {
  host: string;
  port: number;
  apiKey?: string;
  allowedOrigins: string[];
  maxBodyBytes: number;
  frontendDistDir: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function normalizeAllowedOrigin(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`AUTORECRUIT_CONSOLE_ALLOWED_ORIGINS contains an invalid origin: ${trimmed || '<empty>'}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new Error(`AUTORECRUIT_CONSOLE_ALLOWED_ORIGINS must contain HTTP(S) origins only: ${trimmed}`);
  }
  return parsed.origin;
}

function parseAllowedOrigins(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const origins = value.split(',').map((item) => item.trim()).filter(Boolean).map(normalizeAllowedOrigin);
  return [...new Set(origins)];
}

function defaultLoopbackOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ];
}

function validateConsoleApiConfig(config: ConsoleApiConfig): ConsoleApiConfig {
  const host = config.host.trim();
  const apiKey = config.apiKey?.trim() || undefined;
  const allowedOrigins = [...new Set(config.allowedOrigins.map(normalizeAllowedOrigin))];
  if (!host) throw new Error('AUTORECRUIT_CONSOLE_HOST must not be empty');
  if (!isLoopbackHost(host) && !apiKey) {
    throw new Error('AUTORECRUIT_CONSOLE_API_KEY is required when AUTORECRUIT_CONSOLE_HOST is not loopback');
  }
  if (!isLoopbackHost(host) && allowedOrigins.length === 0) {
    throw new Error('AUTORECRUIT_CONSOLE_ALLOWED_ORIGINS is required when AUTORECRUIT_CONSOLE_HOST is not loopback');
  }
  return { ...config, host, apiKey, allowedOrigins };
}

function parseOptionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

export function resolveConsoleApiConfig(overrides: Partial<ConsoleApiConfig> = {}): ConsoleApiConfig {
  const host = overrides.host ?? process.env.AUTORECRUIT_CONSOLE_HOST?.trim() ?? '127.0.0.1';
  const port = overrides.port ?? parseOptionalPositiveInteger(process.env.AUTORECRUIT_CONSOLE_PORT?.trim(), 'AUTORECRUIT_CONSOLE_PORT') ?? 4180;
  const apiKey = overrides.apiKey ?? process.env.AUTORECRUIT_CONSOLE_API_KEY?.trim();
  const configuredOrigins = overrides.allowedOrigins
    ?? parseAllowedOrigins(process.env.AUTORECRUIT_CONSOLE_ALLOWED_ORIGINS);
  return validateConsoleApiConfig({
    host,
    port,
    apiKey: apiKey || undefined,
    allowedOrigins: configuredOrigins ?? (isLoopbackHost(host) ? defaultLoopbackOrigins(port) : []),
    maxBodyBytes: overrides.maxBodyBytes ?? parseOptionalPositiveInteger(process.env.AUTORECRUIT_CONSOLE_MAX_BODY_BYTES?.trim(), 'AUTORECRUIT_CONSOLE_MAX_BODY_BYTES') ?? 2 * 1024 * 1024,
    frontendDistDir: overrides.frontendDistDir ?? process.env.AUTORECRUIT_CONSOLE_FRONTEND_DIR?.trim() ?? path.resolve('frontend/dist'),
  });
}

function isAuthorized(authorization: string | undefined, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }
  const actual = crypto.createHash('sha256').update(authorization ?? '').digest();
  const expected = crypto.createHash('sha256').update(`Bearer ${apiKey}`).digest();
  return crypto.timingSafeEqual(actual, expected);
}

export interface ConsoleRequestSecurityInspection {
  originAllowed: boolean;
  authorized: boolean;
  responseHeaders: Record<string, string>;
}

export function inspectConsoleRequestSecurity(
  headers: Pick<http.IncomingHttpHeaders, 'authorization' | 'origin'>,
  config: Pick<ConsoleApiConfig, 'apiKey' | 'allowedOrigins'>,
): ConsoleRequestSecurityInspection {
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  const originAllowed = origin === undefined || config.allowedOrigins.includes(origin);
  return {
    originAllowed,
    authorized: isAuthorized(headers.authorization, config.apiKey),
    responseHeaders: {
      vary: 'Origin',
      ...(originAllowed && origin ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      } : {}),
    },
  };
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

function writeJson(response: http.ServerResponse, result: ApiResponse, securityHeaders: Record<string, string>): void {
  if (Buffer.isBuffer(result.body)) {
    response.writeHead(result.statusCode, {
      ...securityHeaders,
      ...result.headers,
    });
    response.end(result.body);
    return;
  }

  response.writeHead(result.statusCode, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
    ...result.headers,
  });
  response.end(`${JSON.stringify(result.body, null, 2)}\n`);
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

async function serveStaticFile(
  requestPathname: string,
  response: http.ServerResponse,
  frontendDistDir: string,
  securityHeaders: Record<string, string>,
): Promise<boolean> {
  const root = path.resolve(frontendDistDir);
  const pathname = requestPathname === '/' ? '/index.html' : requestPathname;
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(root, `.${decoded}`);

  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    response.writeHead(403, securityHeaders);
    response.end('Forbidden');
    return true;
  }

  const filePath = await fs.stat(resolved).then((stat) => stat.isFile() ? resolved : path.join(root, 'index.html')).catch(() => path.join(root, 'index.html'));
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders,
      'content-type': contentTypeFor(filePath),
    });
    response.end(content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export function createConsoleApiServer(config: ConsoleApiConfig): http.Server {
  const validatedConfig = validateConsoleApiConfig(config);
  const taskQueue = new TaskQueue();
  const taskScheduler = new TaskScheduler({ taskQueue });
  const jobReadModel = new JobReadModel();

  const server = http.createServer(async (request, response) => {
    response.on('error', () => undefined);
    const security = inspectConsoleRequestSecurity(request.headers, validatedConfig);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${validatedConfig.host}:${validatedConfig.port}`}`);

    if (!security.originAllowed) {
      writeJson(response, {
        statusCode: 403,
        body: {
          error: {
            code: 'origin_not_allowed',
            message: 'Request origin is not allowed',
          },
        },
      }, security.responseHeaders);
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, security.responseHeaders);
      response.end();
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        if (!security.authorized) {
          writeJson(response, {
            statusCode: 401,
            body: {
              error: {
                code: 'unauthorized',
                message: 'Missing or invalid bearer token',
              },
            },
          }, security.responseHeaders);
          return;
        }

        const body = request.method === 'GET'
          ? undefined
          : await readRequestBody(request, validatedConfig.maxBodyBytes);
        writeJson(response, await handleApiRequest({
          method: request.method ?? 'GET',
          pathname: url.pathname,
          searchParams: url.searchParams,
          body,
          taskQueue,
          taskScheduler,
          jobReadModel,
        }), security.responseHeaders);
        return;
      }

      if (request.method === 'GET' && await serveStaticFile(url.pathname, response, validatedConfig.frontendDistDir, security.responseHeaders)) {
        return;
      }

      writeJson(response, {
        statusCode: 404,
        body: {
          error: {
            code: 'not_found',
            message: `No route for ${request.method ?? 'GET'} ${url.pathname}`,
          },
        },
      }, security.responseHeaders);
    } catch (error) {
      writeJson(response, {
        statusCode: 400,
        body: {
          error: {
            code: 'bad_request',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      }, security.responseHeaders);
    }
  });
  server.once('close', () => taskScheduler.close());
  return server;
}

async function main(): Promise<void> {
  const config = resolveConsoleApiConfig();
  const server = createConsoleApiServer(config);

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(JSON.stringify({
    service: 'autorecruit-console-api',
    host: config.host,
    port: config.port,
    auth: config.apiKey ? 'bearer' : 'none',
    allowedOrigins: config.allowedOrigins,
    frontend: config.frontendDistDir,
    endpoints: [
      'GET /api/health',
      'GET /api/operation-modes',
      'GET /api/platform-browser-runtimes',
      'GET /api/tasks',
      'GET /api/schedules',
      'POST /api/schedules',
      'POST /api/assistant/chat',
      'POST /api/assistant/validate',
      'POST /api/assistant/confirm',
      'POST /api/tasks/resume-capture',
      'POST /api/tasks/batch',
      'POST /api/tasks/talent-mapping',
      'POST /api/tasks/talent-mapping-classification',
      'POST /api/tasks/search-subscription',
      'POST /api/tasks/boss-auto-chat',
      'POST /api/tasks/boss-talent-search',
      'POST /api/tasks/boss-greet',
      'POST /api/tasks/boss-chat-operation',
      'POST /api/tasks/boss-job-sync',
      'GET /api/jobs',
      'GET /api/talent-mappings',
      'GET /api/talent-mappings/:mappingKey/changes',
      'GET/POST /api/talent-mappings/:mappingKey/entity-links',
      'GET/POST /api/talent-mappings/:mappingKey/classification-suggestions',
      'POST /api/rag/answer',
      'POST /api/rag/conversations',
    ],
  }, null, 2));
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

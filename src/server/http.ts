import fs from 'node:fs/promises';
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
  maxBodyBytes: number;
  frontendDistDir: string;
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
  const apiKey = overrides.apiKey ?? process.env.AUTORECRUIT_CONSOLE_API_KEY?.trim();
  return {
    host: overrides.host ?? process.env.AUTORECRUIT_CONSOLE_HOST?.trim() ?? '127.0.0.1',
    port: overrides.port ?? parseOptionalPositiveInteger(process.env.AUTORECRUIT_CONSOLE_PORT?.trim(), 'AUTORECRUIT_CONSOLE_PORT') ?? 4180,
    apiKey: apiKey || undefined,
    maxBodyBytes: overrides.maxBodyBytes ?? parseOptionalPositiveInteger(process.env.AUTORECRUIT_CONSOLE_MAX_BODY_BYTES?.trim(), 'AUTORECRUIT_CONSOLE_MAX_BODY_BYTES') ?? 2 * 1024 * 1024,
    frontendDistDir: overrides.frontendDistDir ?? process.env.AUTORECRUIT_CONSOLE_FRONTEND_DIR?.trim() ?? path.resolve('frontend/dist'),
  };
}

function isAuthorized(headers: http.IncomingHttpHeaders, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }

  return headers.authorization === `Bearer ${apiKey}`;
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

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  };
}

function writeJson(response: http.ServerResponse, result: ApiResponse): void {
  response.writeHead(result.statusCode, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
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
): Promise<boolean> {
  const root = path.resolve(frontendDistDir);
  const pathname = requestPathname === '/' ? '/index.html' : requestPathname;
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(root, `.${decoded}`);

  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    response.writeHead(403, corsHeaders());
    response.end('Forbidden');
    return true;
  }

  const filePath = await fs.stat(resolved).then((stat) => stat.isFile() ? resolved : path.join(root, 'index.html')).catch(() => path.join(root, 'index.html'));
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      ...corsHeaders(),
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
  const taskQueue = new TaskQueue();
  const taskScheduler = new TaskScheduler({ taskQueue });
  const jobReadModel = new JobReadModel();

  const server = http.createServer(async (request, response) => {
    response.on('error', () => undefined);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${config.host}:${config.port}`}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        if (!isAuthorized(request.headers, config.apiKey)) {
          writeJson(response, {
            statusCode: 401,
            body: {
              error: {
                code: 'unauthorized',
                message: 'Missing or invalid bearer token',
              },
            },
          });
          return;
        }

        const body = request.method === 'GET'
          ? undefined
          : await readRequestBody(request, config.maxBodyBytes);
        writeJson(response, await handleApiRequest({
          method: request.method ?? 'GET',
          pathname: url.pathname,
          searchParams: url.searchParams,
          body,
          taskQueue,
          taskScheduler,
          jobReadModel,
        }));
        return;
      }

      if (request.method === 'GET' && await serveStaticFile(url.pathname, response, config.frontendDistDir)) {
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
      });
    } catch (error) {
      writeJson(response, {
        statusCode: 400,
        body: {
          error: {
            code: 'bad_request',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
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
    frontend: config.frontendDistDir,
    endpoints: [
      'GET /api/health',
      'GET /api/tasks',
      'GET /api/schedules',
      'POST /api/schedules',
      'POST /api/assistant/chat',
      'POST /api/assistant/validate',
      'POST /api/assistant/confirm',
      'POST /api/tasks/resume-capture',
      'POST /api/tasks/batch',
      'POST /api/tasks/search-subscription',
      'POST /api/tasks/boss-auto-chat',
      'POST /api/tasks/boss-talent-search',
      'POST /api/tasks/boss-greet',
      'POST /api/tasks/boss-chat-operation',
      'POST /api/tasks/boss-job-sync',
      'GET /api/jobs',
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

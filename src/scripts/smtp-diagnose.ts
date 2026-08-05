import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

import { config } from '../config.js';

const DEFAULT_ATTEMPTS = 1;
const MAX_ATTEMPTS = 5;
const SOCKET_TIMEOUT_MS = 12_000;
const MAX_GREETING_BYTES = 4_096;

type AddressCategory = 'synthetic' | 'private' | 'public' | 'other';

function parseAttempts(argv: readonly string[]): number {
  const index = argv.indexOf('--attempts');
  if (index < 0) return DEFAULT_ATTEMPTS;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS) {
    throw new Error(`--attempts must be an integer between 1 and ${MAX_ATTEMPTS}`);
  }
  return value;
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function addressCategory(address: string): AddressCategory {
  if (!isIpv4(address)) return address.includes(':') ? 'public' : 'other';
  const [first, second] = address.split('.').map(Number);
  if (first === 198 && second >= 18 && second <= 19) return 'synthetic';
  if (first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)) return 'private';
  return 'public';
}

async function resolveHost(host: string): Promise<{ count: number; categories: AddressCategory[]; error?: string }> {
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    return {
      count: addresses.length,
      categories: [...new Set(addresses.map((entry) => addressCategory(entry.address)))],
    };
  } catch (error) {
    return {
      count: 0,
      categories: [],
      error: error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'DNS_ERROR',
    };
  }
}

interface GreetingProbeResult {
  attempt: number;
  ok: boolean;
  phase: 'connect' | 'tls' | 'greeting' | 'protocol' | 'error';
  durationMs: number;
  greetingCode?: string;
  errorCode?: string;
}

function probeGreeting(host: string, port: number, attempt: number): Promise<GreetingProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const secure = port === 465;
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port });
    let completed = false;
    let greetingBuffer = '';

    const finish = (result: Omit<GreetingProbeResult, 'attempt' | 'durationMs'>): void => {
      if (completed) return;
      completed = true;
      socket.destroy();
      resolve({
        attempt,
        ...result,
        durationMs: Date.now() - startedAt,
      });
    };

    socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish({
      ok: false,
      phase: 'greeting',
      errorCode: 'TIMEOUT',
    }));
    socket.once('error', (error) => finish({
      ok: false,
      phase: secure ? 'tls' : 'error',
      errorCode: (error as NodeJS.ErrnoException).code ?? error.name,
    }));
    socket.once('close', () => finish({
      ok: false,
      phase: 'greeting',
      errorCode: 'CONNECTION_CLOSED',
    }));
    socket.on('data', (data) => {
      greetingBuffer += data.toString('utf8');
      if (Buffer.byteLength(greetingBuffer, 'utf8') > MAX_GREETING_BYTES) {
        finish({ ok: false, phase: 'protocol', errorCode: 'GREETING_TOO_LARGE' });
        return;
      }
      const newlineIndex = greetingBuffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const firstLine = greetingBuffer.slice(0, newlineIndex).replace(/\r$/u, '');
      const greetingCode = /^\d{3}/u.exec(firstLine)?.[0];
      finish(greetingCode === '220'
        ? { ok: true, phase: 'greeting', greetingCode }
        : { ok: false, phase: 'protocol', greetingCode: greetingCode ?? 'none', errorCode: 'INVALID_GREETING' });
    });
  });
}

async function main(): Promise<void> {
  const attempts = parseAttempts(process.argv.slice(2));
  const host = config.smtp.host.trim();
  const port = config.smtp.port;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP host/port configuration is incomplete or invalid');
  }

  const resolution = await resolveHost(host);
  const probes: GreetingProbeResult[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    probes.push(await probeGreeting(host, port, attempt));
  }
  const successful = probes.filter((probe) => probe.ok).length;
  console.log(JSON.stringify({
    host,
    port,
    secure: port === 465,
    resolution,
    attempts,
    successful,
    probes,
    note: 'Read-only SMTP greeting probe; no EHLO, AUTH, MAIL, RCPT, DATA, or credentials used.',
  }, null, 2));
  if (successful !== attempts) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

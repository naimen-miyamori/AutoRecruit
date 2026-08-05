import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('smtp diagnose uses a local greeting fixture without authenticating or sending', async () => {
  const server = net.createServer((socket) => {
    socket.write('2');
    setImmediate(() => socket.end('20 local-smtp-fixture ESMTP\r\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const child = spawn(
      process.execPath,
      ['--import', './scripts/node-ts-hooks.mjs', 'src/scripts/smtp-diagnose.ts', '--attempts', '2'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(address.port),
          SMTP_USER: 'fixture-user',
          SMTP_PASS: 'fixture-pass',
          SMTP_FROM: 'fixture@outlook.com',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number>((resolve) => {
      child.once('close', (code) => resolve(code ?? -1));
    });

    assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'));
    const result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
      host: string;
      port: number;
      secure: boolean;
      successful: number;
      probes: Array<{ phase: string; greetingCode?: string }>;
      note: string;
    };
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.port, address.port);
    assert.equal(result.secure, false);
    assert.equal(result.successful, 2);
    assert.deepEqual(result.probes.map((probe) => [probe.phase, probe.greetingCode]), [
      ['greeting', '220'],
      ['greeting', '220'],
    ]);
    assert.match(result.note, /no EHLO, AUTH, MAIL, RCPT, DATA/);
    assert.doesNotMatch(Buffer.concat(stdout).toString('utf8'), /fixture-(?:user|pass)/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

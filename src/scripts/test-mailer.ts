import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import nodemailer from 'nodemailer';

import {
  assertDeliverableEmailAddress,
  normalizeMailDeliveryError,
  sendJobReportEmail,
  type MailTransportPayload,
} from '../reporting/mailer.js';

test('mailer accepts real mailbox domains and preserves CC recipients', async () => {
  let payload: MailTransportPayload | undefined;
  const result = await sendJobReportEmail(
    {
      recipient: 'recruiter@outlook.com',
      ccEmails: ['audit@163.com'],
      subject: 'subject',
      markdown: '# report',
      messageId: '<stable-message-id@example.local>',
    },
    {
      sendMail: async (nextPayload) => {
        payload = nextPayload;
      },
    },
    {
      host: 'smtp.example-provider.test',
      port: 587,
      user: 'sender@outlook.com',
      pass: 'not-used-by-fake-transport',
      from: 'sender@outlook.com',
    },
  );

  assert.equal(result.recipient, 'recruiter@outlook.com');
  assert.deepEqual(payload, {
    from: 'sender@outlook.com',
    to: 'recruiter@outlook.com',
    cc: ['audit@163.com'],
    subject: 'subject',
    text: '# report',
    messageId: '<stable-message-id@example.local>',
  });
});

test('mailer rejects malformed addresses before creating an SMTP transport', () => {
  assert.throws(
    () => assertDeliverableEmailAddress('not-an-email', 'recipient'),
    /Invalid recipient/,
  );
});

test('mailer rejects reserved documentation and test domains', () => {
  for (const address of [
    'secondary-report-two@example.com',
    'secondary-report@example.test',
    'recruiter@sub.example.org',
  ]) {
    assert.throws(
      () => assertDeliverableEmailAddress(address, 'recipient'),
      /reserved\/test email domain/,
    );
  }
});

test('mailer validates CC addresses before sending anything', async () => {
  let sendCalls = 0;
  await assert.rejects(
    sendJobReportEmail(
      {
        recipient: 'recruiter@outlook.com',
        ccEmails: ['audit@example.com'],
        subject: 'subject',
        markdown: '# report',
      },
      {
        sendMail: async () => {
          sendCalls += 1;
        },
      },
      {
        host: 'smtp.example-provider.test',
        port: 587,
        user: 'sender@outlook.com',
        pass: 'not-used-by-fake-transport',
        from: 'sender@outlook.com',
      },
    ),
    /reserved\/test email domain/,
  );
  assert.equal(sendCalls, 0);
});

test('mailer classifies only proven pre-submit SMTP failures as retryable', () => {
  const greetingTimeout = normalizeMailDeliveryError(Object.assign(
    new Error('Greeting never received'),
    { code: 'ETIMEDOUT', command: 'CONN' },
  ));
  assert.deepEqual(greetingTimeout.evidence, {
    phase: 'unknown',
    retrySafety: 'uncertain',
    retryDisposition: 'none',
    code: 'ETIMEDOUT',
    command: 'CONN',
  });

  const dnsFailure = normalizeMailDeliveryError(Object.assign(
    new Error('DNS resolution failed'),
    { code: 'EDNS', command: 'CONN' },
  ));
  assert.deepEqual(dnsFailure.evidence, {
    phase: 'connect',
    retrySafety: 'known-not-sent',
    retryDisposition: 'immediate-once',
    code: 'EDNS',
    command: 'CONN',
  });

  const authFailure = normalizeMailDeliveryError(Object.assign(
    new Error('authentication failed'),
    { code: 'EAUTH', command: 'AUTH' },
  ));
  assert.deepEqual(authFailure.evidence, {
    phase: 'auth',
    retrySafety: 'known-not-sent',
    retryDisposition: 'deferred-once',
    code: 'EAUTH',
    command: 'AUTH',
  });

  const dataFailure = normalizeMailDeliveryError(Object.assign(
    new Error('connection closed during DATA'),
    { code: 'ECONNRESET', command: 'DATA' },
  ));
  assert.deepEqual(dataFailure.evidence, {
    phase: 'data',
    retrySafety: 'uncertain',
    retryDisposition: 'none',
    code: 'ECONNRESET',
    command: 'DATA',
  });

  const mailFailure = normalizeMailDeliveryError(Object.assign(
    new Error('MAIL FROM rejected'),
    { code: 'EENVELOPE', command: 'MAIL FROM' },
  ));
  assert.equal(mailFailure.evidence.phase, 'envelope');
  assert.equal(mailFailure.evidence.retrySafety, 'known-not-sent');
  assert.equal(mailFailure.evidence.retryDisposition, 'deferred-once');

  const rcptFailure = normalizeMailDeliveryError(Object.assign(
    new Error('RCPT TO rejected'),
    { code: 'EENVELOPE', command: 'RCPT TO' },
  ));
  assert.equal(rcptFailure.evidence.phase, 'envelope');
  assert.equal(rcptFailure.evidence.retrySafety, 'uncertain');
  assert.equal(rcptFailure.evidence.retryDisposition, 'none');

  const nonTransientConnection = normalizeMailDeliveryError(Object.assign(
    new Error('certificate rejected'),
    { code: 'CERT_HAS_EXPIRED', command: 'CONN' },
  ));
  assert.equal(nonTransientConnection.evidence.phase, 'unknown');
  assert.equal(nonTransientConnection.evidence.retrySafety, 'uncertain');
  assert.equal(nonTransientConnection.evidence.retryDisposition, 'none');

  for (const code of ['ESOCKET', 'ECONNECTION']) {
    const connectionFailure = normalizeMailDeliveryError(Object.assign(
      new Error('socket failed after an unknown SMTP phase'),
      { code, command: 'CONN' },
    ));
    assert.equal(connectionFailure.evidence.phase, 'unknown');
    assert.equal(connectionFailure.evidence.retrySafety, 'uncertain');
    assert.equal(connectionFailure.evidence.retryDisposition, 'none');
  }
});

test('mailer does not infer retry safety from an SMTP error message alone', () => {
  const normalized = normalizeMailDeliveryError(new Error('Greeting never received'));
  assert.doesNotMatch(normalized.message, /Greeting never received/);
  assert.deepEqual(normalized.evidence, {
    phase: 'unknown',
    retrySafety: 'uncertain',
    retryDisposition: 'none',
  });
});

test('mailer treats a Nodemailer socket close after DATA as uncertain even when command is CONN', async () => {
  let dataSubmitted = false;
  const server = net.createServer((socket) => {
    let buffer = '';
    let readingData = false;
    socket.write('220 local-smtp-fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (readingData) {
        if (buffer.includes('\r\n.\r\n')) {
          dataSubmitted = true;
          socket.destroy();
        }
        return;
      }
      while (true) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        if (/^(?:EHLO|HELO)\b/iu.test(line)) {
          socket.write('250-localhost\r\n250 PIPELINING\r\n');
        } else if (/^MAIL FROM:/iu.test(line) || /^RCPT TO:/iu.test(line)) {
          socket.write('250 2.1.0 accepted\r\n');
        } else if (line === 'DATA') {
          readingData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          if (buffer.includes('\r\n.\r\n')) {
            dataSubmitted = true;
            socket.destroy();
          }
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port: address.port,
      secure: false,
      ignoreTLS: true,
    });
    await assert.rejects(
      sendJobReportEmail(
        {
          recipient: 'recruiter@outlook.com',
          subject: 'subject',
          markdown: '# report',
        },
        { sendMail: (payload) => transport.sendMail(payload) },
        {
          host: '127.0.0.1',
          port: address.port,
          user: 'not-used',
          pass: 'not-used',
          from: 'sender@outlook.com',
        },
      ),
      (error: unknown) => {
        const normalized = normalizeMailDeliveryError(error);
        assert.equal(dataSubmitted, true);
        assert.equal(normalized.evidence.command, 'CONN');
        assert.equal(normalized.evidence.retrySafety, 'uncertain');
        assert.equal(normalized.evidence.retryDisposition, 'none');
        return true;
      },
    );
    transport.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('mailer rejects a resolved partial-recipient result without retaining addresses', async () => {
  await assert.rejects(
    sendJobReportEmail(
      {
        recipient: 'recruiter@outlook.com',
        ccEmails: ['audit@163.com'],
        subject: 'subject',
        markdown: '# report',
      },
      {
        sendMail: async () => ({
          accepted: ['recruiter@outlook.com'],
          rejected: ['audit@163.com'],
        }),
      },
      {
        host: 'smtp.example-provider.test',
        port: 587,
        user: 'sender@outlook.com',
        pass: 'not-used-by-fake-transport',
        from: 'sender@outlook.com',
      },
    ),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const normalized = normalizeMailDeliveryError(error);
      assert.deepEqual(normalized.evidence, {
        phase: 'data',
        retrySafety: 'uncertain',
        retryDisposition: 'none',
        code: 'EPARTIAL',
        command: 'DATA',
      });
      assert.match(normalized.message, /rejectedCount=1/);
      assert.doesNotMatch(normalized.message, /recruiter@outlook\.com|audit@163\.com/);
      return true;
    },
  );
});

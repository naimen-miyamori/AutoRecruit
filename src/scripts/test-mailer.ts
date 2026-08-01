import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDeliverableEmailAddress,
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

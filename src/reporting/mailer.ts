import nodemailer from 'nodemailer';

import { config } from '../config.js';
import type { JobResultsMarkdownSummary } from '../types/job.js';
import type { SupportedPlatform } from '../platforms/types.js';

export interface SendJobReportEmailParams {
  recipient: string;
  ccEmails?: string[];
  subject: string;
  markdown: string;
  /** Stable caller-owned identity for candidate-level idempotent delivery. */
  messageId?: string;
}

export interface SendJobReportEmailResult {
  recipient: string;
  subject: string;
}

export interface MailTransportPayload {
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  messageId?: string;
}

export interface MailTransport {
  sendMail(payload: MailTransportPayload): Promise<unknown>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'localhost',
]);

function isReservedEmailDomain(domain: string): boolean {
  const normalized = domain.toLowerCase();
  return RESERVED_EMAIL_DOMAINS.has(normalized)
    || normalized.endsWith('.example.com')
    || normalized.endsWith('.example.net')
    || normalized.endsWith('.example.org')
    || normalized.endsWith('.invalid')
    || normalized.endsWith('.test')
    || normalized.endsWith('.localhost');
}

/**
 * Rejects malformed and documentation/test mailbox addresses immediately
 * before SMTP delivery. Configuration persistence still accepts test values
 * for offline fixtures, but production delivery must fail closed instead of
 * generating a bounce for a known placeholder domain.
 */
export function assertDeliverableEmailAddress(value: string, label = 'email address'): void {
  const normalized = assertEmailAddressSyntax(value, label);

  const atIndex = normalized.lastIndexOf('@');
  const domain = normalized.slice(atIndex + 1);
  if (isReservedEmailDomain(domain)) {
    throw new Error(
      `Refusing to send ${label} ${JSON.stringify(value)}: reserved/test email domain ${JSON.stringify(domain)}`,
    );
  }
}

/** Validates mailbox syntax without rejecting reserved domains used by offline fixtures. */
export function assertEmailAddressSyntax(value: string, label = 'email address'): string {
  const normalized = value.trim();
  if (!normalized || !EMAIL_ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function assertDeliverableRecipients(recipient: string, ccEmails?: string[]): void {
  assertDeliverableEmailAddress(recipient, 'recipient');
  for (const [index, ccEmail] of (ccEmails ?? []).entries()) {
    assertDeliverableEmailAddress(ccEmail, `cc[${index}]`);
  }
}

function getSmtpConfig(): SmtpConfig {
  const { host, port, user, pass, from } = config.smtp;

  if (!host || !user || !pass || !from) {
    throw new Error('SMTP configuration is incomplete');
  }

  return { host, port, user, pass, from };
}

/** Fails before browser work or outbox dispatch without exposing SMTP values. */
export function assertSmtpConfigurationReady(): void {
  void getSmtpConfig();
}

export function createSmtpTransport(): MailTransport {
  const smtp = getSmtpConfig();

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });
}

export function buildJobReportEmailSubject(jobTitle: string, summary: JobResultsMarkdownSummary): string {
  return `${jobTitle} 评分结果（${summary.successCount}/${summary.candidateCount}）`;
}

export function buildNoNewCandidatesEmailSubject(jobTitle: string): string {
  return `${jobTitle} 本次无新增候选人`;
}

export function buildNoNewCandidatesEmailBody(
  jobTitle: string,
  platform: SupportedPlatform,
  jobKey: string,
  fetchedAt: string,
): string {
  return [
    `# ${jobTitle} 无新增候选人通知`,
    '',
    `- 平台来源: ${platform}`,
    `- jobKey: \`${jobKey}\``,
    `- fetchedAt: \`${fetchedAt}\``,
    `- 新增候选人数: 0`,
    '',
    '本次抓取未发现新的候选人，新增候选人数为 0。',
  ].join('\n');
}

export async function sendJobReportEmail(
  params: SendJobReportEmailParams,
  transport?: MailTransport,
  smtp?: SmtpConfig,
): Promise<SendJobReportEmailResult> {
  assertDeliverableRecipients(params.recipient, params.ccEmails);
  const resolvedTransport = transport ?? createSmtpTransport();
  const resolvedSmtp = smtp ?? getSmtpConfig();

  await resolvedTransport.sendMail({
    from: resolvedSmtp.from,
    to: params.recipient,
    ...(params.ccEmails?.length ? { cc: params.ccEmails } : {}),
    subject: params.subject,
    text: params.markdown,
    ...(params.messageId ? { messageId: params.messageId } : {}),
  });

  return {
    recipient: params.recipient,
    subject: params.subject,
  };
}

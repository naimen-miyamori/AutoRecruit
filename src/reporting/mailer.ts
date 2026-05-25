import nodemailer from 'nodemailer';

import { config } from '../config.js';
import type { JobResultsMarkdownSummary } from '../types/job.js';
import type { SupportedPlatform } from '../platforms/types.js';

export interface SendJobReportEmailParams {
  recipient: string;
  ccEmails?: string[];
  subject: string;
  markdown: string;
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

function getSmtpConfig(): SmtpConfig {
  const { host, port, user, pass, from } = config.smtp;

  if (!host || !user || !pass || !from) {
    throw new Error('SMTP configuration is incomplete');
  }

  return { host, port, user, pass, from };
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
  transport: MailTransport = createSmtpTransport(),
  smtp: SmtpConfig = getSmtpConfig(),
): Promise<SendJobReportEmailResult> {
  await transport.sendMail({
    from: smtp.from,
    to: params.recipient,
    ...(params.ccEmails?.length ? { cc: params.ccEmails } : {}),
    subject: params.subject,
    text: params.markdown,
  });

  return {
    recipient: params.recipient,
    subject: params.subject,
  };
}

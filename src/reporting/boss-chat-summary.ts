import { sendJobReportEmail } from './mailer.js';
import type { BossChatReviewItem, BossChatReviewRun } from '../types/job.js';

export interface BossChatSummaryDelivery {
  recipient: string;
  ccEmails?: string[];
}

export interface BossChatSummaryEmailResult {
  recipient: string;
  subject: string;
}

export const sendBossChatSummaryEmailRef = { fn: sendJobReportEmail };

function displayJobs(run: BossChatReviewRun): string {
  return [...new Set(run.items.map((item) => item.jobName).filter(Boolean))].join('、') || 'Boss岗位';
}

function displayCandidate(item: BossChatReviewItem): string {
  const id = item.candidateId ?? `未取得；会话ID: ${item.conversationId}`;
  return `${item.candidateName ?? '姓名未知'}（ID: ${id}）`;
}

function displayReasons(item: BossChatReviewItem): string {
  const hardRequirementReasons = item.hardRequirementEvaluation?.rejectionReasons ?? [];
  if (hardRequirementReasons.length > 0) {
    return hardRequirementReasons.join('；');
  }

  if (item.error) {
    return item.error;
  }

  if (item.score && item.matched === false) {
    return `总分 ${item.score.totalScore}，未达到本次阈值`;
  }

  return item.matched ? '符合要求' : '未取得足够证据确认符合要求';
}

function renderItems(items: BossChatReviewItem[], emptyText: string, includeReasons: boolean): string[] {
  if (items.length === 0) {
    return [emptyText];
  }

  return items.map((item) => {
    const contact = item.matched
      ? `，符合常用语${item.chatMessageSent ? '已发送' : '未发送'}，换电话${item.phoneExchangeRequested ? '已请求' : '未请求'}`
      : item.matched === false
        ? `，不合适常用语${item.chatMessageSent ? '已发送' : '未发送'}${item.error ? `：${item.error}` : ''}`
        : '';
    const forwarding = item.forwarded
      ? item.error
        ? `，已转发，但联系动作未完成：${item.error}`
        : '，已转发'
      : item.matched
        ? `，转发未完成${item.error ? `：${item.error}` : ''}`
        : '';
    const reasons = includeReasons ? `：${displayReasons(item)}` : '';
    return `- ${displayCandidate(item)}${contact}${forwarding}${reasons}`;
  });
}

export function buildBossChatSummarySubject(run: BossChatReviewRun): string {
  return `${displayJobs(run)} Boss未读候选人审查总结（符合${run.matchedCandidates}/审查${run.reviewedConversations}）`;
}

export function renderBossChatSummaryMarkdown(run: BossChatReviewRun): string {
  const matched = run.items.filter((item) => item.matched === true);
  const unmatched = run.items.filter((item) => item.matched !== true);

  return [
    `# ${displayJobs(run)} Boss未读候选人审查总结`,
    '',
    `- 处理时间: ${run.reviewedAt}`,
    `- 匹配模式: ${run.matchMode === 'all-hard-requirements' ? '所有硬性要求必须同时满足' : `总分阈值 ${run.scoreThreshold}`}`,
    `- 未读会话: ${run.unreadConversations}`,
    `- 已审查: ${run.reviewedConversations}`,
    `- 符合要求: ${run.matchedCandidates}`,
    `- 已发送聊天: ${run.chatMessagesSent}`,
    `- 已请求换电话: ${run.phoneExchangeRequests}`,
    `- 已转发: ${run.forwardedCandidates}`,
    `- 跳过: ${run.skippedConversations}`,
    `- 失败: ${run.failedConversations}`,
    '',
    '## 符合要求的候选人',
    '',
    ...renderItems(matched, '无', false),
    '',
    '## 不符合或无法确认的候选人',
    '',
    ...renderItems(unmatched, '无', true),
  ].join('\n');
}

export async function sendBossChatSummary(
  run: BossChatReviewRun,
  delivery: BossChatSummaryDelivery,
): Promise<BossChatSummaryEmailResult> {
  const recipient = delivery.recipient.trim();
  if (!recipient) {
    throw new Error('Boss chat summary recipient must be a non-empty email address.');
  }

  return sendBossChatSummaryEmailRef.fn({
    recipient,
    ccEmails: delivery.ccEmails,
    subject: buildBossChatSummarySubject(run),
    markdown: renderBossChatSummaryMarkdown(run),
  });
}

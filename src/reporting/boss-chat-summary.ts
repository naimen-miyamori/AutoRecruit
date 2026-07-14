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
  return [...new Set(run.items.map((item) => item.jobName.replace(/\s+/g, ' ').trim()).filter(Boolean))].join('、') || 'Boss岗位';
}

function sanitizeMarkdownInline(value: string | undefined): string {
  return (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]<>|])/g, '\\$1');
}

function displayCandidate(item: BossChatReviewItem): string {
  const id = item.candidateId
    ? sanitizeMarkdownInline(item.candidateId)
    : `未取得；会话ID: ${sanitizeMarkdownInline(item.conversationId)}`;
  return `${sanitizeMarkdownInline(item.candidateName) || '姓名未知'}（ID: ${id}）`;
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
    const previousChat = item.previousChat
      ? item.previousChat.previouslyChatted
        ? '，此前已聊过'
        : '，此前未聊过'
      : '';
    const contact = item.status === 'awaiting_clarification'
      ? `，上海籍确认消息${item.clarificationQuestionSent ? '已发送，等待回复' : '未发送'}`
      : item.matched
      ? `，符合常用语${item.chatMessageSent ? '已发送' : '未发送'}，换电话${item.phoneExchangeRequested ? '已请求' : '未请求'}`
      : item.matched === false
        ? `，不合适常用语${item.chatMessageSent ? '已发送' : '未发送'}${item.error ? `：${sanitizeMarkdownInline(item.error)}` : ''}`
        : '';
    const forwarding = item.forwarded
      ? item.error
        ? `，已转发，但联系动作未完成：${sanitizeMarkdownInline(item.error)}`
        : '，已转发'
      : item.matched
        ? `，转发未完成${item.error ? `：${sanitizeMarkdownInline(item.error)}` : ''}`
        : '';
    const reasons = includeReasons ? `：${sanitizeMarkdownInline(displayReasons(item))}` : '';
    return `- ${displayCandidate(item)}${previousChat}${contact}${forwarding}${reasons}`;
  });
}

const replyTypeLabels = {
  text: '文本',
  image: '图片',
  resume: '简历',
  attachment: '附件',
  voice: '语音',
  video: '视频',
  other: '其他',
} as const;

function renderFollowUpItems(items: BossChatReviewItem[]): string[] {
  if (items.length === 0) {
    return ['无'];
  }

  return items.flatMap((item) => {
    const replies = item.newCandidateReplies ?? [];
    return [
      `- ${displayCandidate(item)}，岗位：${sanitizeMarkdownInline(item.jobName)}，新回复 ${replies.length} 条`,
      ...replies.map((reply, index) => {
        const metadata = [reply.messageId ? `消息ID: ${sanitizeMarkdownInline(reply.messageId)}` : '', reply.sentAt ? `时间: ${sanitizeMarkdownInline(reply.sentAt)}` : '']
          .filter(Boolean)
          .join('，');
        return `  - ${index + 1}. [${replyTypeLabels[reply.type]}] ${sanitizeMarkdownInline(reply.content)}${metadata ? `（${metadata}）` : ''}`;
      }),
    ];
  });
}

export function buildBossChatSummarySubject(run: BossChatReviewRun): string {
  return `${displayJobs(run)} Boss未读候选人审查总结（符合${run.matchedCandidates}/审查${run.reviewedConversations}）`;
}

export function renderBossChatSummaryMarkdown(run: BossChatReviewRun): string {
  const matched = run.items.filter((item) => item.matched === true && item.previousChat?.previouslyChatted !== true);
  const unmatched = run.items.filter((item) => (
    (item.matched === false || item.status === 'awaiting_clarification')
    && item.previousChat?.previouslyChatted !== true
  ));
  const followUps = run.items.filter((item) => item.status === 'follow_up_reply');
  const unresolved = run.items.filter((item) => (
    item.matched === undefined
    && item.status !== 'awaiting_clarification'
    && item.status !== 'follow_up_reply'
  ));
  const awaitingClarification = run.items.filter((item) => item.status === 'awaiting_clarification').length;
  const previouslyChatted = run.previouslyChattedConversations
    ?? run.items.filter((item) => item.previousChat?.previouslyChatted === true).length;
  const firstContact = run.firstContactConversations
    ?? run.items.filter((item) => item.previousChat?.previouslyChatted === false).length;
  const followUpConversations = run.followUpConversations ?? followUps.length;
  const newReplyMessages = run.newReplyMessages
    ?? followUps.reduce((total, item) => total + (item.newCandidateReplies?.length ?? 0), 0);

  return [
    `# ${sanitizeMarkdownInline(displayJobs(run))} Boss未读候选人审查总结`,
    '',
    `- 处理时间: ${run.reviewedAt}`,
    `- 匹配模式: ${run.matchMode === 'all-hard-requirements' ? '所有硬性要求必须同时满足' : `总分阈值 ${run.scoreThreshold}`}`,
    `- 未读会话: ${run.unreadConversations}`,
    `- 已审查: ${run.reviewedConversations}`,
    `- 符合要求: ${run.matchedCandidates}`,
    `- 等待上海籍确认: ${awaitingClarification}`,
    `- 此前已聊过: ${previouslyChatted}`,
    `- 此前未聊过: ${firstContact}`,
    `- 跟进回复会话: ${followUpConversations}`,
    `- 新回复消息: ${newReplyMessages}`,
    `- 已发送聊天: ${run.chatMessagesSent}`,
    `- 已请求换电话: ${run.phoneExchangeRequests}`,
    `- 已转发: ${run.forwardedCandidates}`,
    `- 跳过: ${run.skippedConversations}`,
    `- 失败: ${run.failedConversations}`,
    '',
    '## 已聊过候选人的新回复',
    '',
    ...renderFollowUpItems(followUps),
    '',
    '## 符合要求的候选人',
    '',
    ...renderItems(matched, '无', false),
    '',
    '## 不符合或等待确认的候选人',
    '',
    ...renderItems(unmatched, '无', true),
    '',
    '## 未完成的会话',
    '',
    ...renderItems(unresolved, '无', true),
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

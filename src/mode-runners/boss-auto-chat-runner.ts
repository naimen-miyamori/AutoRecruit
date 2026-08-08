import type { BrowserSession } from '../browser/session.js';
import type { JobStore } from '../storage/job-store.js';
import type {
  BossAutomationSettings,
  BossChatReviewItem,
  BossChatReviewRun,
  CandidateResume,
  JobRecord,
  NormalizedJob,
} from '../types/job.js';
import type { BossAutoChatCliInput } from './types.js';

export interface BossAutoChatRunSummary extends BossChatReviewRun {
  resultPath: string;
  summaryEmailRecipient?: string;
  summaryEmailSubject?: string;
}

export interface BossAutoChatRunnerDependencies {
  createStore: () => JobStore;
  now: () => Date;
  buildJobKey: (keyword: string, suffix: string) => string;
  scoringModel: string;
  openSession: () => Promise<BrowserSession>;
  closeSession: (session: BrowserSession) => Promise<void>;
  syncPositions: typeof import('../platforms/boss-jobs.js').syncBossPositions;
  openChatPage: typeof import('../platforms/boss-chat.js').openBossChatPage;
  collectUnreadConversations: typeof import('../platforms/boss-chat.js').collectBossUnreadConversations;
  openUnreadConversation: typeof import('../platforms/boss-chat.js').openBossUnreadConversation;
  openAndParseResume: typeof import('../platforms/boss-chat.js').openAndParseBossChatResume;
  closeResume: typeof import('../platforms/boss-chat.js').closeBossChatResume;
  contactQualified: typeof import('../platforms/boss-chat.js').contactBossQualifiedCandidate;
  contactShanghaiOrigin: typeof import('../platforms/boss-chat.js').contactBossShanghaiOriginCandidate;
  contactUnqualified: typeof import('../platforms/boss-chat.js').contactBossUnqualifiedCandidate;
  forwardResume: typeof import('../platforms/boss-adapter.js').forwardBossResume;
  evaluateHardRequirements: typeof import('../scoring/boss-chat-hard-requirements.js').evaluatePropertyElectricianHardRequirements;
  scoreResume: typeof import('../scoring/score-resume.js').scoreResumeAgainstJob;
  sendSummary: typeof import('../reporting/boss-chat-summary.js').sendBossChatSummary;
  formatResumeSnapshot: (resume: CandidateResume) => string;
  report: (summary: BossAutoChatRunSummary) => void;
}

function supportsPropertyElectricianHardRequirements(
  jobKey: string,
  job: NormalizedJob,
  buildJobKey: BossAutoChatRunnerDependencies['buildJobKey'],
): boolean {
  if (jobKey !== buildJobKey('物业电工', '')) return false;
  const requirements = job.hardRequirements.join(' ');
  return /47岁|年龄/.test(requirements)
    && /高压/.test(requirements)
    && /低压/.test(requirements)
    && /物业/.test(requirements)
    && /2年|两年|24个月/.test(requirements)
    && /上海人|沪籍|上海户籍/.test(requirements);
}

function resolveBossAutomationSettings(
  stored: BossAutomationSettings,
  input: BossAutoChatCliInput,
): BossAutomationSettings {
  const forwarding = input.bossForwardMode && input.bossForwardRecipient
    ? {
      mode: input.bossForwardMode,
      recipient: input.bossForwardRecipient,
      ...(input.bossForwardCc === undefined
        ? (stored.forwarding?.ccEmails === undefined ? {} : { ccEmails: stored.forwarding.ccEmails })
        : { ccEmails: input.bossForwardCc }),
    }
    : input.bossForwardCc === undefined
      ? stored.forwarding
      : stored.forwarding
        ? { ...stored.forwarding, ccEmails: input.bossForwardCc }
        : undefined;
  if (forwarding?.ccEmails?.length && forwarding.mode !== 'email') {
    throw new Error('Boss forward CC can only be used with email forwarding.');
  }
  return {
    forwarding,
    summaryDelivery: input.summaryEmail
      ? { recipientEmail: input.summaryEmail, ccEmails: input.summaryCcEmails }
      : stored.summaryDelivery,
  };
}

async function resolveBossConversationJob(
  store: JobStore,
  conversation: { bossJobId?: string; jobName: string },
): Promise<{ jobKey: string; jobRecord: JobRecord }> {
  const jobRecord = await store.resolveBossConversationJobRecord(conversation);
  return { jobKey: jobRecord.jobKey, jobRecord };
}

export async function runBossAutoChatMode(
  input: BossAutoChatCliInput,
  dependencies: BossAutoChatRunnerDependencies,
): Promise<BossAutoChatRunSummary> {
  const store = dependencies.createStore();
  const reviewedAt = dependencies.now().toISOString();
  const storedAutomationSettings = await store.readBossAutomationSettings();
  const automationSettings = resolveBossAutomationSettings(storedAutomationSettings, input);
  if ((input.bossForwardMode && input.bossForwardRecipient) || input.bossForwardCc !== undefined || input.summaryEmail) {
    await store.saveBossAutomationSettings(automationSettings);
  }
  const session = await dependencies.openSession();
  const items: BossChatReviewItem[] = [];

  try {
    if (input.syncJobsBeforeReview) {
      const syncRun = await dependencies.syncPositions(session.page, { platform: 'boss', includeClosed: true });
      if (syncRun.failed > 0) {
        throw new Error(`Boss job sync failed for ${syncRun.failed} position(s); aborting auto-chat before conversation review.`);
      }
    }
    const chatPage = await dependencies.openChatPage(session.page);
    session.page = chatPage;
    const retryItems = await store.readBossChatRetryItems();
    const conversations = await dependencies.collectUnreadConversations(chatPage, retryItems.map((item) => ({
      conversationId: item.conversationId,
      candidateName: item.candidateName,
      jobName: item.jobName,
      bossJobId: item.bossJobId,
      unreadCount: item.unreadCount,
    })));
    const reviewedConversationIdSet = new Set(await store.readBossChatReviewedConversationIds());

    for (const conversation of conversations) {
      const fallbackJobKey = dependencies.buildJobKey(conversation.jobName, '');
      const isUnreadEvent = conversation.hasUnreadBadge !== false;
      if (!isUnreadEvent && reviewedConversationIdSet.has(conversation.conversationId)) {
        items.push({
          conversationId: conversation.conversationId,
          candidateName: conversation.candidateName,
          jobName: conversation.jobName,
          bossJobId: conversation.bossJobId,
          jobKey: fallbackJobKey,
          unreadCount: conversation.unreadCount,
          status: 'skipped_previously_reviewed',
        });
        continue;
      }

      let item: BossChatReviewItem = {
        conversationId: conversation.conversationId,
        candidateName: conversation.candidateName,
        jobName: conversation.jobName,
        bossJobId: conversation.bossJobId,
        jobKey: fallbackJobKey,
        unreadCount: conversation.unreadCount,
        status: 'failed',
      };
      let resumeOpened = false;
      let shouldMarkReviewed = false;

      try {
        const opened = await dependencies.openUnreadConversation(chatPage, conversation);
        item = {
          ...item,
          candidateId: opened.candidate.candidateId,
          candidateName: opened.candidate.name ?? opened.resume.name ?? conversation.candidateName,
          previousChat: opened.previousChat,
          ...(opened.newCandidateReplies ? { newCandidateReplies: opened.newCandidateReplies } : {}),
        };

        if (opened.previousChat.previouslyChatted) {
          if (opened.newCandidateRepliesError) throw new Error(opened.newCandidateRepliesError);
          if (!opened.newCandidateReplies || opened.newCandidateReplies.length === 0) {
            throw new Error(`Unable to reliably extract unread Boss candidate replies for conversation ${conversation.conversationId}.`);
          }
          item = { ...item, status: 'follow_up_reply' };
          shouldMarkReviewed = true;
        } else {
          const { jobRecord, jobKey } = await resolveBossConversationJob(store, conversation);
          item = { ...item, jobKey };
          const forwarding = input.bossForwardMode && input.bossForwardRecipient
            ? {
              mode: input.bossForwardMode,
              recipient: input.bossForwardRecipient,
              ...(input.bossForwardCc === undefined
                ? (jobRecord.bossForwarding?.ccEmails === undefined ? {} : { ccEmails: jobRecord.bossForwarding.ccEmails })
                : { ccEmails: input.bossForwardCc }),
            }
            : input.bossForwardCc === undefined
              ? jobRecord.bossForwarding ?? automationSettings.forwarding
              : jobRecord.bossForwarding
                ? { ...jobRecord.bossForwarding, ccEmails: input.bossForwardCc }
                : automationSettings.forwarding
                  ? { ...automationSettings.forwarding, ccEmails: input.bossForwardCc }
                  : undefined;
          if (!forwarding) throw new Error(`Missing stored Boss forwarding configuration for job ${conversation.jobName}`);
          if (forwarding.ccEmails?.length && forwarding.mode !== 'email') {
            throw new Error('Boss forward CC can only be used with email forwarding.');
          }
          if (jobRecord.bossForwarding?.mode !== forwarding.mode
            || jobRecord.bossForwarding?.recipient !== forwarding.recipient
            || JSON.stringify(jobRecord.bossForwarding?.ccEmails ?? []) !== JSON.stringify(forwarding.ccEmails ?? [])) {
            await store.saveJobRecord('boss', { ...jobRecord, bossForwarding: forwarding });
          }

          if (input.requireAllHardRequirements
            && !supportsPropertyElectricianHardRequirements(jobKey, jobRecord.normalizedJob, dependencies.buildJobKey)) {
            item = {
              ...item,
              status: 'skipped_unsupported_hard_requirements',
              error: `All-hard-requirements evaluation is not configured for Boss job ${conversation.jobName}`,
            };
            shouldMarkReviewed = true;
          } else {
            resumeOpened = true;
            const resume = await dependencies.openAndParseResume(chatPage, opened);
            item = { ...item, candidateId: resume.candidateId, candidateName: resume.name ?? conversation.candidateName };
            await store.saveCandidateResume('boss', jobKey, resume, dependencies.formatResumeSnapshot(resume));

            let matched: boolean;
            let clarificationRequired = false;
            if (input.requireAllHardRequirements) {
              const hardRequirementEvaluation = dependencies.evaluateHardRequirements(resume);
              matched = hardRequirementEvaluation.allMet;
              clarificationRequired = Boolean(hardRequirementEvaluation.clarification);
              item = {
                ...item,
                hardRequirementEvaluation,
                matched: clarificationRequired ? undefined : matched,
                forwarded: false,
                status: clarificationRequired ? 'awaiting_clarification' : matched ? 'failed' : 'not_matched',
              };
            } else {
              const scoredAt = dependencies.now().toISOString();
              try {
                const score = await dependencies.scoreResume(jobRecord.normalizedJob, resume);
                await store.saveCandidateScoreArtifact('boss', jobKey, {
                  candidateId: resume.candidateId,
                  candidateShareUrl: resume.candidateShareUrl,
                  model: dependencies.scoringModel,
                  scoredAt,
                  status: 'success',
                  score,
                });
                matched = score.totalScore >= input.scoreThreshold;
                item = { ...item, score, matched, forwarded: false, status: matched ? 'failed' : 'not_matched' };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await store.saveCandidateScoreArtifact('boss', jobKey, {
                  candidateId: resume.candidateId,
                  candidateShareUrl: resume.candidateShareUrl,
                  model: dependencies.scoringModel,
                  scoredAt,
                  status: 'failed',
                  error: message,
                });
                throw error;
              }
            }

            if (clarificationRequired) {
              await dependencies.closeResume(chatPage);
              resumeOpened = false;
              const contactResult = await dependencies.contactShanghaiOrigin(chatPage);
              item = { ...item, chatMessageSent: contactResult.messageSent, clarificationQuestionSent: contactResult.messageSent };
            } else if (matched) {
              await dependencies.forwardResume(
                chatPage,
                opened.candidate,
                forwarding.mode,
                forwarding.recipient,
                'confirm',
                forwarding.ccEmails,
                false,
              );
              item = { ...item, forwarded: true, status: 'forwarded' };
              shouldMarkReviewed = true;
              await dependencies.closeResume(chatPage);
              resumeOpened = false;
              const contactResult = await dependencies.contactQualified(chatPage);
              item = {
                ...item,
                chatMessageSent: contactResult.messageSent,
                phoneExchangeRequested: contactResult.phoneExchangeRequested,
              };
            } else {
              await dependencies.closeResume(chatPage);
              resumeOpened = false;
              if (input.replyToUnqualifiedCandidates) {
                const contactResult = await dependencies.contactUnqualified(chatPage);
                item = { ...item, chatMessageSent: contactResult.messageSent };
              }
              shouldMarkReviewed = true;
            }
          }
        }
      } catch (error) {
        item = { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (resumeOpened) await dependencies.closeResume(chatPage).catch(() => undefined);
        if (shouldMarkReviewed) {
          reviewedConversationIdSet.add(conversation.conversationId);
          await store.saveBossChatReviewedConversationIds([...reviewedConversationIdSet]);
        }
      }
      items.push(item);
    }

    const run: BossChatReviewRun = {
      platform: 'boss',
      reviewedAt,
      scoreThreshold: input.scoreThreshold,
      matchMode: input.requireAllHardRequirements ? 'all-hard-requirements' : 'score-threshold',
      replyToUnqualifiedCandidates: input.replyToUnqualifiedCandidates,
      unreadConversations: conversations.length,
      reviewedConversations: items.filter((item) => !item.status.startsWith('skipped_')).length,
      matchedCandidates: items.filter((item) => item.matched).length,
      chatMessagesSent: items.filter((item) => item.chatMessageSent).length,
      phoneExchangeRequests: items.filter((item) => item.phoneExchangeRequested).length,
      forwardedCandidates: items.filter((item) => item.forwarded).length,
      skippedConversations: items.filter((item) => item.status.startsWith('skipped_')).length,
      failedConversations: items.filter((item) => item.status === 'failed').length,
      previouslyChattedConversations: items.filter((item) => item.previousChat?.previouslyChatted === true).length,
      firstContactConversations: items.filter((item) => item.previousChat?.previouslyChatted === false).length,
      followUpConversations: items.filter((item) => item.status === 'follow_up_reply').length,
      newReplyMessages: items
        .filter((item) => item.status === 'follow_up_reply')
        .reduce((total, item) => total + (item.newCandidateReplies?.length ?? 0), 0),
      items,
    };
    const resultPath = await store.saveBossChatReviewRun(run);
    const emailSummary = automationSettings.summaryDelivery
      ? await dependencies.sendSummary(run, {
        recipient: automationSettings.summaryDelivery.recipientEmail,
        ccEmails: automationSettings.summaryDelivery.ccEmails,
      })
      : undefined;
    const summary: BossAutoChatRunSummary = {
      ...run,
      resultPath,
      summaryEmailRecipient: emailSummary?.recipient,
      summaryEmailSubject: emailSummary?.subject,
    };
    dependencies.report(summary);
    return summary;
  } finally {
    await dependencies.closeSession(session);
  }
}

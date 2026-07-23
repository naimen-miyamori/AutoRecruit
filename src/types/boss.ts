export type BossTalentSource = 'normal-search' | 'recommend' | 'deep-search';

export type BossContactState = 'greet' | 'continue-chat' | 'unknown';

export interface BossTalentCandidate {
  candidateId: string;
  name?: string;
  summary?: string;
  workSummary?: string;
  educationSummary?: string;
  recommendationReason?: string;
  contactState: BossContactState;
  source: BossTalentSource;
  searchResultIndex: number;
}

export interface BossDeepSearchForm {
  bossJobId?: string;
  jobName: string;
  coreRequirements: string[];
  bonusRequirements: string[];
  remainingMatchCount?: number;
  matchButtonEnabled: boolean;
}

export interface BossTalentSearchInput {
  platform: 'boss';
  source: 'recommend' | 'deep-search';
  bossJobId?: string;
  expectedJobName?: string;
  coreRequirements?: string[];
  bonusRequirements?: string[];
  triggerMatch?: boolean;
  confirmed?: boolean;
}

export interface BossTalentSearchResult {
  platform: 'boss';
  source: BossTalentSearchInput['source'];
  form?: BossDeepSearchForm;
  matched: boolean;
  candidates: BossTalentCandidate[];
}

export interface BossGreetInput {
  platform: 'boss';
  source: BossTalentSource;
  candidateId: string;
  expectedCandidateName: string;
  expectedJobName: string;
  bossJobId?: string;
  confirmed: boolean;
  intentId?: string;
}

export interface BossGreetResult {
  platform: 'boss';
  candidateId: string;
  candidateName?: string;
  jobName: string;
  source: BossTalentSource;
  greeted: boolean;
  alreadyContacted: boolean;
  intentId?: string;
  completedAt: string;
}

export type BossChatOperation =
  | 'list-conversations'
  | 'open-conversation'
  | 'read-conversation'
  | 'read-history'
  | 'preview-resume'
  | 'send-text'
  | 'remark'
  | 'mark-not-fit'
  | 'request-attachment-resume'
  | 'accept-attachment-resume'
  | 'exchange-phone'
  | 'exchange-wechat';

export interface BossChatOperationInput {
  platform: 'boss';
  action: BossChatOperation;
  conversationId?: string;
  expectedCandidateName?: string;
  expectedJobName?: string;
  text?: string;
  remark?: string;
  intentId?: string;
  unreadOnly?: boolean;
  confirmed?: boolean;
}

export interface BossChatConversationSummary {
  conversationId: string;
  candidateId?: string;
  candidateName?: string;
  jobName: string;
  bossJobId?: string;
  unreadCount: number;
  hasUnreadBadge?: boolean;
}

export interface BossChatMessage {
  messageId?: string;
  sender: 'candidate' | 'recruiter' | 'system' | 'unknown';
  type?: string;
  content: string;
  sentAt?: string;
}

export interface BossChatOperationResult {
  platform: 'boss';
  action: BossChatOperation;
  conversationId?: string;
  candidateId?: string;
  candidateName?: string;
  jobName?: string;
  bossJobId?: string;
  conversations?: BossChatConversationSummary[];
  messages?: BossChatMessage[];
  resume?: unknown;
  changed: boolean;
  intentId?: string;
  completedAt: string;
  receiptPath?: string;
}

export type BossPositionStatus = 'open' | 'pending' | 'closed' | 'unknown';

export interface BossPositionSummary {
  bossJobId: string;
  name: string;
  status: BossPositionStatus;
  location?: string;
}

export interface BossPositionDetail extends BossPositionSummary {
  rawJd: string;
  salaryText?: string;
  department?: string;
  sourceUpdatedAt?: string;
}

export interface BossJobSyncInput {
  platform: 'boss';
  bossJobIds?: string[];
  includeClosed?: boolean;
}

export interface BossJobSyncItem {
  bossJobId: string;
  name: string;
  status: BossPositionStatus;
  jobKey?: string;
  sourceHash?: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'failed';
  error?: string;
}

export interface BossJobSyncRun {
  platform: 'boss';
  syncedAt: string;
  positions: BossPositionSummary[];
  items: BossJobSyncItem[];
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  resultPath?: string;
}

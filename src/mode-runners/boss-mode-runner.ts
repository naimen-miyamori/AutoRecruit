import type { BrowserSession } from '../browser/session.js';
import type {
  BossChatOperationResult,
  BossGreetResult,
  BossJobSyncRun,
  BossTalentSearchResult,
} from '../types/boss.js';
import type {
  BossChatOperationCliInput,
  BossGreetCliInput,
  BossJobSyncCliInput,
  BossTalentSearchCliInput,
} from './types.js';

export interface BossStandaloneRunnerDependencies {
  openSession: () => Promise<BrowserSession>;
  closeSession: (session: BrowserSession) => Promise<void>;
  runTalentSearch: (session: BrowserSession, input: BossTalentSearchCliInput) => Promise<BossTalentSearchResult>;
  runGreet: (session: BrowserSession, input: BossGreetCliInput) => Promise<BossGreetResult>;
  runChatOperation: (session: BrowserSession, input: BossChatOperationCliInput) => Promise<BossChatOperationResult>;
  runJobSync: (session: BrowserSession, input: BossJobSyncCliInput) => Promise<BossJobSyncRun>;
  report: (result: BossTalentSearchResult | BossGreetResult | BossChatOperationResult | BossJobSyncRun) => void;
}

async function withBossSession<Result>(
  dependencies: BossStandaloneRunnerDependencies,
  operation: (session: BrowserSession) => Promise<Result>,
): Promise<Result> {
  const session = await dependencies.openSession();
  try {
    const result = await operation(session);
    dependencies.report(result as BossTalentSearchResult | BossGreetResult | BossChatOperationResult | BossJobSyncRun);
    return result;
  } finally {
    await dependencies.closeSession(session);
  }
}

export function runBossTalentSearchMode(
  input: BossTalentSearchCliInput,
  dependencies: BossStandaloneRunnerDependencies,
): Promise<BossTalentSearchResult> {
  return withBossSession(dependencies, (session) => dependencies.runTalentSearch(session, input));
}

export function runBossGreetMode(
  input: BossGreetCliInput,
  dependencies: BossStandaloneRunnerDependencies,
): Promise<BossGreetResult> {
  return withBossSession(dependencies, (session) => dependencies.runGreet(session, input));
}

export function runBossChatOperationMode(
  input: BossChatOperationCliInput,
  dependencies: BossStandaloneRunnerDependencies,
): Promise<BossChatOperationResult> {
  return withBossSession(dependencies, (session) => dependencies.runChatOperation(session, input));
}

export function runBossJobSyncMode(
  input: BossJobSyncCliInput,
  dependencies: BossStandaloneRunnerDependencies,
): Promise<BossJobSyncRun> {
  return withBossSession(dependencies, (session) => dependencies.runJobSync(session, input));
}

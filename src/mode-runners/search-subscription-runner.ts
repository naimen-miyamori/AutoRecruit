import type { BrowserSession } from '../browser/session.js';
import type { PlatformAdapter, SupportedPlatform } from '../platforms/types.js';
import {
  loadSearchConditionPlanFile,
  SearchSubscriptionRunError,
} from '../search/search-subscription.js';
import { SearchConditionSetService } from '../search/search-condition-sets.js';
import type { SearchConditionPlan, SearchSubscriptionSummary } from '../types/job.js';
import type { SearchSubscriptionCliInput } from './types.js';

export interface SearchSubscriptionRunnerDependencies {
  listPlatforms: (selection: SearchSubscriptionCliInput['platform'], includeBoss: boolean) => SupportedPlatform[];
  resolveAdapter: (platform: SupportedPlatform) => PlatformAdapter;
  openSession: (platform: SupportedPlatform) => Promise<BrowserSession>;
  closeSession: (session: BrowserSession) => Promise<void>;
  handoffWorkPage?: (session: BrowserSession, oldPage: BrowserSession['page'], newPage: BrowserSession['page']) => Promise<void>;
  runWorkflow: (
    adapter: PlatformAdapter,
    page: BrowserSession['page'],
    plan: SearchConditionPlan,
    options: { save: boolean; savedSearchName?: string; sortPolicy?: 'match-priority'; onWorkPageResolved?: (page: BrowserSession['page']) => Promise<void> },
  ) => Promise<SearchSubscriptionSummary>;
  report: (result: SearchSubscriptionSummary | SearchSubscriptionSummary[] | undefined) => void;
  reportFailure: (summary: unknown) => void;
  preflightRuntimes?: (platforms: readonly SupportedPlatform[]) => Promise<void>;
}

export async function runSearchSubscriptionMode(
  input: SearchSubscriptionCliInput,
  dependencies: SearchSubscriptionRunnerDependencies,
): Promise<SearchSubscriptionSummary | SearchSubscriptionSummary[]> {
  const summaries: SearchSubscriptionSummary[] = [];
  const conditionSetService = input.searchConditionSetRefs ? new SearchConditionSetService() : undefined;
  const platforms = dependencies.listPlatforms(input.platform, input.includeBoss);
  await dependencies.preflightRuntimes?.(platforms);

  for (const platform of platforms) {
    let session: BrowserSession | undefined;
    let stageSummary: SearchSubscriptionSummary | undefined;
    let failure: unknown;
    try {
      const adapter = dependencies.resolveAdapter(platform);
      const conditionSet = input.searchConditionSetRefs?.[platform]
        ? await conditionSetService!.resolve(input.searchConditionSetRefs[platform]!)
        : undefined;
      const plan = await loadSearchConditionPlanFile(input.filePath, {
        platform,
        keywordOverride: input.keyword ?? conditionSet?.revision.defaultKeyword,
        savedSearchNameOverride: input.savedSearchName,
      });
      if (conditionSet && plan.conditions.some((condition) => condition.kind === 'applicationFilter')) {
        throw new Error(`--search-subscription-file cannot include applicationFilter conditions when --search-condition-set is selected for ${platform}`);
      }
      const resolvedPlan = conditionSet
        ? { ...plan, conditions: [...plan.conditions, ...conditionSet.conditions] }
        : plan;
      session = await dependencies.openSession(adapter.platform);
      const initialWorkPage = session.page;
      stageSummary = await dependencies.runWorkflow(adapter, session.page, resolvedPlan, {
        save: input.save,
        savedSearchName: input.savedSearchName,
        ...(platform === 'boss' ? { sortPolicy: 'match-priority' as const } : {}),
        ...(session.runtimeLease && dependencies.handoffWorkPage ? {
          onWorkPageResolved: async (resolvedPage) => {
            if (resolvedPage !== session!.page) {
              await dependencies.handoffWorkPage!(session!, initialWorkPage, resolvedPage);
            }
          },
        } : {}),
      });
    } catch (error) {
      failure = error;
    } finally {
      if (session) {
        try {
          await dependencies.closeSession(session);
        } catch (error) {
          failure ??= error;
        }
      }
    }
    if (stageSummary) summaries.push(stageSummary);
    if (failure !== undefined) {
      const message = failure instanceof Error ? failure.message : String(failure);
      const summary = {
        mode: 'search-subscription' as const,
        status: 'failed' as const,
        completedPlatforms: summaries.map((item) => item.platform),
        stoppedPlatform: platform,
        results: [...summaries],
        error: message,
      };
      dependencies.reportFailure(summary);
      throw new SearchSubscriptionRunError(summary, failure);
    }
  }

  const result = input.platform === 'all' ? summaries : summaries[0];
  dependencies.report(result);
  return result;
}

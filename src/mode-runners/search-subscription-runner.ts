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
  runWorkflow: (
    adapter: PlatformAdapter,
    page: BrowserSession['page'],
    plan: SearchConditionPlan,
    options: { save: boolean; savedSearchName?: string; sortPolicy?: 'match-priority' },
  ) => Promise<SearchSubscriptionSummary>;
  report: (result: SearchSubscriptionSummary | SearchSubscriptionSummary[] | undefined) => void;
  reportFailure: (summary: unknown) => void;
}

export async function runSearchSubscriptionMode(
  input: SearchSubscriptionCliInput,
  dependencies: SearchSubscriptionRunnerDependencies,
): Promise<SearchSubscriptionSummary | SearchSubscriptionSummary[]> {
  const summaries: SearchSubscriptionSummary[] = [];
  const conditionSetService = input.searchConditionSetRefs ? new SearchConditionSetService() : undefined;

  for (const platform of dependencies.listPlatforms(input.platform, input.includeBoss)) {
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
      stageSummary = await dependencies.runWorkflow(adapter, session.page, resolvedPlan, {
        save: input.save,
        savedSearchName: input.savedSearchName,
        ...(platform === 'boss' ? { sortPolicy: 'match-priority' as const } : {}),
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

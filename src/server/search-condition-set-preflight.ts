import { SearchConditionSetService } from '../search/search-condition-sets.js';
import type { SearchConditionSetReference } from '../search/search-condition-sets.js';
import type { SearchConditionSetReferenceMap, TaskInput } from './types.js';

function referencesForTask(input: TaskInput): SearchConditionSetReference[] {
  if (!('searchConditionSetRefs' in input) || !input.searchConditionSetRefs) {
    return [];
  }

  const refs = input.searchConditionSetRefs as SearchConditionSetReferenceMap;
  return Object.values(refs).filter((reference): reference is SearchConditionSetReference => Boolean(reference));
}

/**
 * The normalizer verifies only the request shape.  This preflight is the
 * queue/scheduler boundary: it proves that each selected immutable revision is
 * still active and compatible with the current platform catalog before a task
 * is persisted or a browser can be opened.
 */
export async function preflightTaskSearchConditionSets(
  input: TaskInput,
  service: SearchConditionSetService,
): Promise<void> {
  await Promise.all(referencesForTask(input).map(async (reference) => {
    await service.resolve(reference);
  }));
}

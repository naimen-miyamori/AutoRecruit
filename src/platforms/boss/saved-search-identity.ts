import { createHash } from 'node:crypto';
import type { SavedSearchConditionIdentity } from '../../types/job.js';

export function normalizeBossSavedSearchIdentity(identity: SavedSearchConditionIdentity): SavedSearchConditionIdentity {
  const normalizedCityOptions = (identity.cityOptions ?? [])
    .map((value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  return {
    jobScope: identity.jobScope.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
    ...(identity.city === undefined ? {} : { city: identity.city.normalize('NFKC').replace(/\s+/gu, ' ').trim() || undefined }),
    ...(identity.cityOptions === undefined ? {} : { cityOptions: normalizedCityOptions }),
    ...(identity.company === undefined ? {} : { company: identity.company.normalize('NFKC').replace(/\s+/gu, ' ').trim() || undefined }),
    inline: Object.fromEntries(Object.entries(identity.inline).map(([key, values]) => [
      key,
      values.map((value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim()).filter(Boolean).sort(),
    ])),
    more: Object.fromEntries(Object.entries(identity.more)
      .map(([key, value]) => [key.normalize('NFKC').replace(/\s+/gu, ' ').trim(), value.normalize('NFKC').replace(/\s+/gu, ' ').trim()] as const)
      .filter(([key, value]) => Boolean(key && value))),
    toggles: Object.fromEntries(Object.entries(identity.toggles)
      .map(([key, value]) => [key.normalize('NFKC').replace(/\s+/gu, ' ').trim(), Boolean(value)] as const)),
  };
}

export function canonicalizeSavedSearchIdentityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeSavedSearchIdentityValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeSavedSearchIdentityValue(item)]));
  }
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return value;
}

export function fingerprintSavedSearchConditionIdentity(identity: SavedSearchConditionIdentity): string {
  const normalized = normalizeBossSavedSearchIdentity(identity);
  return createHash('sha256').update(JSON.stringify(canonicalizeSavedSearchIdentityValue(normalized))).digest('hex');
}

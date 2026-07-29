import { createHash } from 'node:crypto';

import type {
  MappingCandidateView,
  MappingEntityLink,
  MappingEntityLinkSuggestion,
} from '../types/talent-mapping.js';

function normalizedIdentityText(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return normalized || undefined;
}

export function activeMappingEntityLinks(links: readonly MappingEntityLink[]): MappingEntityLink[] {
  return links.filter((link) => !link.revokedAt);
}

export function countConfirmedMappingEntities(
  platformProfileCount: number,
  links: readonly MappingEntityLink[],
): number {
  const activeLinks = activeMappingEntityLinks(links);
  const linkedKeys = new Set(activeLinks.flatMap((link) => link.platformCandidateKeys));
  return platformProfileCount - linkedKeys.size + activeLinks.length;
}

export function buildMappingEntityLinkSuggestions(
  candidates: readonly MappingCandidateView[],
  links: readonly MappingEntityLink[],
): MappingEntityLinkSuggestion[] {
  const linkedKeys = new Set(activeMappingEntityLinks(links).flatMap((link) => link.platformCandidateKeys));
  const candidatesByName = new Map<string, MappingCandidateView[]>();
  for (const candidate of candidates) {
    if (linkedKeys.has(candidate.platformCandidateKey)) continue;
    const name = normalizedIdentityText(candidate.name);
    if (!name || name.length < 2) continue;
    const values = candidatesByName.get(name) ?? [];
    values.push(candidate);
    candidatesByName.set(name, values);
  }

  const suggestions: MappingEntityLinkSuggestion[] = [];
  for (const sameNameCandidates of candidatesByName.values()) {
    for (let leftIndex = 0; leftIndex < sameNameCandidates.length; leftIndex += 1) {
      const left = sameNameCandidates[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < sameNameCandidates.length; rightIndex += 1) {
        const right = sameNameCandidates[rightIndex]!;
        if (left.platform === right.platform) continue;

        const evidence = ['姓名完全一致'];
        const sameCompany = Boolean(
          left.companyKey && right.companyKey && left.companyKey === right.companyKey,
        ) || Boolean(
          normalizedIdentityText(left.currentCompany)
          && normalizedIdentityText(left.currentCompany) === normalizedIdentityText(right.currentCompany),
        );
        const sameRole = Boolean(
          left.roleKey && right.roleKey && left.roleKey === right.roleKey,
        ) || Boolean(
          normalizedIdentityText(left.currentTitle)
          && normalizedIdentityText(left.currentTitle) === normalizedIdentityText(right.currentTitle),
        );
        if (!sameCompany && !sameRole) continue;
        if (sameCompany) evidence.push('当前公司一致');
        if (sameRole) evidence.push('当前岗位一致');

        const platformCandidateKeys = [left.platformCandidateKey, right.platformCandidateKey]
          .sort() as [string, string];
        const suggestionId = createHash('sha256')
          .update(platformCandidateKeys.join('\u001f'))
          .digest('hex');
        suggestions.push({ suggestionId, platformCandidateKeys, evidence });
      }
    }
  }

  return suggestions.sort((left, right) => left.suggestionId.localeCompare(right.suggestionId));
}

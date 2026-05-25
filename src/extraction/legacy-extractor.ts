import { load } from 'cheerio';
import { Page } from 'playwright';
import { candidateCardSelector, collectCandidateList, parseCandidateCards } from '../browser/candidate-list.js';
import { parseResumeDetail, parseResumeFromSource } from '../browser/resume-detail.js';
import { CandidateListItem, ResumeDomSnapshot } from '../types/job.js';
import { CandidateListExtractionResult, ExtractionBoundary, ResumeExtractionResult, validateCandidateListExtraction, validateResumeExtraction } from './extractor.js';
import { RawPageSource } from './page-source.js';
import type { SearchWaitOptions } from '../platforms/types.js';

export async function extractCandidateListFromPage(page: Page, options?: SearchWaitOptions): Promise<CandidateListExtractionResult> {
  const candidates = await collectCandidateList(page, options);
  return validateCandidateListExtraction({ candidates });
}

export async function extractResumeFromPage(page: Page, candidate: CandidateListItem): Promise<ResumeExtractionResult> {
  const parsed = await parseResumeDetail(page, candidate);

  return validateResumeExtraction({
    resume: parsed.resume,
    domSnapshot: parsed.domSnapshot,
  });
}

function resolveResumeUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) {
    return undefined;
  }

  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

export async function extractCandidateListFromSource(source: RawPageSource): Promise<CandidateListExtractionResult> {
  const $ = load(source.html);
  const cards = $('.virtual_list').first().find(candidateCardSelector)
    .map((_, element) => {
      const base = $(element);
      const container = base.closest('.talent-card, .resume-card, .candidate-card, li, .item, .result-item, [class*="card"]');
      const resolved = container.length > 0 ? container : base;
      const linkElement = resolved.find('a[href]').first();
      const nameElement = resolved.find('[class*=name], [title]').first();

      return {
        elementId: base.attr('id') || undefined,
        html: $.html(resolved),
        text: resolved.text().trim(),
        resumeUrl: resolveResumeUrl(linkElement.attr('href') || undefined, source.url),
        name: nameElement.text().trim() || undefined,
      };
    })
    .get();
  const candidates = parseCandidateCards(cards);

  return validateCandidateListExtraction({ candidates, source });
}

export async function extractResumeFromSource(source: RawPageSource, candidate: CandidateListItem, domSnapshot?: ResumeDomSnapshot): Promise<ResumeExtractionResult> {
  return validateResumeExtraction({
    resume: parseResumeFromSource(source, candidate, domSnapshot),
    domSnapshot,
    source,
  });
}

export function createLegacyExtractionBoundary(): ExtractionBoundary {
  return {
    extractCandidateListFromPage,
    extractCandidateListFromSource,
    extractResumeFromPage,
    extractResumeFromSource,
  };
}

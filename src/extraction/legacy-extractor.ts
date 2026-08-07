import { load } from 'cheerio';
import type { Page } from 'playwright';
import { parseResumeDetail, parseResumeFromSource } from '../browser/resume-detail.js';
import { CandidateListItem, ResumeDomSnapshot } from '../types/job.js';
import {
  fiftyOneJobCandidateAnchorSelector,
  parse51jobCandidateCards,
} from '../platforms/51job/parsing/candidate-list.js';
import {
  CandidateListExtractionResult,
  ExtractionBoundary,
  ResumeExtractionResult,
  validateCandidateListExtraction,
  validateResumeExtraction,
} from './extractor.js';
import { RawPageSource } from './page-source.js';

/** The legacy boundary keeps offline/source conversion and resume compatibility only. */
export type LegacyExtractionBoundary = Omit<ExtractionBoundary, 'extractCandidateListFromPage'>;

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
  const cards = $('.virtual_list').first().find(fiftyOneJobCandidateAnchorSelector)
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
  const candidates = parse51jobCandidateCards(cards);

  return validateCandidateListExtraction({ candidates, source });
}

export async function extractResumeFromSource(source: RawPageSource, candidate: CandidateListItem, domSnapshot?: ResumeDomSnapshot): Promise<ResumeExtractionResult> {
  return validateResumeExtraction({
    resume: parseResumeFromSource(source, candidate, domSnapshot),
    domSnapshot,
    source,
  });
}

export function createLegacyExtractionBoundary(): LegacyExtractionBoundary {
  return {
    extractCandidateListFromSource,
    extractResumeFromPage,
    extractResumeFromSource,
  };
}

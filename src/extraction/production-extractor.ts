import type { Page } from 'playwright';
import { extract51jobCandidateList } from '../platforms/51job/actions/candidate-actions.js';
import { ExtractionBoundary } from './extractor.js';
import {
  extractCandidateListFromSource,
  extractResumeFromPage,
} from './legacy-extractor.js';
import { extractResumeFromSource } from './crawl4ai-extractor.js';

/**
 * A retained compatibility boundary for offline tooling. Ordinary capture
 * invokes the adapter action directly; the live page path therefore remains
 * owned by the concrete 51job candidate action.
 */
async function extractCandidateListFromPage(
  page: Page,
  options?: Parameters<typeof extract51jobCandidateList>[1],
) {
  return extract51jobCandidateList(page, options);
}

export function createProductionExtractionBoundary(): ExtractionBoundary {
  return {
    extractCandidateListFromPage,
    extractCandidateListFromSource,
    extractResumeFromPage,
    extractResumeFromSource,
  };
}

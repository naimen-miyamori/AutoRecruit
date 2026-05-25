import { ExtractionBoundary } from './extractor.js';
import {
  extractCandidateListFromPage,
  extractCandidateListFromSource,
  extractResumeFromPage,
} from './legacy-extractor.js';
import { extractResumeFromSource } from './crawl4ai-extractor.js';

export function createProductionExtractionBoundary(): ExtractionBoundary {
  return {
    extractCandidateListFromPage,
    extractCandidateListFromSource,
    extractResumeFromPage,
    extractResumeFromSource,
  };
}

import type { RagChunk, RagQueryResult, RagVectorFilter } from './types.js';

interface TokenizedChunk {
  chunk: RagChunk;
  tokens: string[];
  termCounts: Map<string, number>;
}

export interface HybridSearchWeights {
  dense: number;
  keyword: number;
  rerank: number;
}

export interface HybridSearchOptions {
  denseResults: RagQueryResult[];
  chunks: RagChunk[];
  question: string;
  filter: RagVectorFilter;
  limit: number;
  keywordLimit?: number;
  rerankCandidateLimit?: number;
  weights?: Partial<HybridSearchWeights>;
}

const DEFAULT_KEYWORD_LIMIT_MULTIPLIER = 4;
const DEFAULT_RERANK_CANDIDATE_MULTIPLIER = 3;
const RRF_K = 60;
const DEFAULT_WEIGHTS: HybridSearchWeights = {
  dense: 1,
  keyword: 1.2,
  rerank: 0.45,
};

const TOKEN_PATTERN = /[\p{Script=Han}]|[a-zA-Z0-9]+/gu;

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(TOKEN_PATTERN)].map((match) => match[0]);
}

function buildTermCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function matchesFilter(chunk: RagChunk, filter: RagVectorFilter): boolean {
  if (chunk.platform !== filter.platform || chunk.jobKey !== filter.jobKey) {
    return false;
  }

  if (filter.active !== undefined && chunk.active !== filter.active) {
    return false;
  }

  if (filter.verified !== undefined && chunk.verified !== filter.verified) {
    return false;
  }

  if (filter.conversationId !== undefined && chunk.conversationId !== filter.conversationId) {
    return false;
  }

  if (filter.sourceTypes && !filter.sourceTypes.includes(chunk.sourceType)) {
    return false;
  }

  if (filter.factOnly && chunk.sourceType !== 'jd' && !chunk.verified) {
    return false;
  }

  return true;
}

export function keywordSearch(question: string, chunks: RagChunk[], filter: RagVectorFilter, limit: number): RagQueryResult[] {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0 || limit <= 0) {
    return [];
  }

  const queryTerms = [...new Set(queryTokens)];
  const tokenizedChunks: TokenizedChunk[] = chunks
    .filter((chunk) => matchesFilter(chunk, filter))
    .map((chunk) => {
      const tokens = tokenize(chunk.text);
      return {
        chunk,
        tokens,
        termCounts: buildTermCounts(tokens),
      };
    })
    .filter((item) => item.tokens.length > 0);

  if (tokenizedChunks.length === 0) {
    return [];
  }

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(term, tokenizedChunks.filter((item) => item.termCounts.has(term)).length);
  }

  const averageLength = tokenizedChunks.reduce((sum, item) => sum + item.tokens.length, 0) / tokenizedChunks.length;
  const k1 = 1.2;
  const b = 0.75;

  return tokenizedChunks
    .map((item) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = item.termCounts.get(term) ?? 0;
        if (frequency === 0) {
          continue;
        }

        const documentsWithTerm = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + ((tokenizedChunks.length - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5)));
        const denominator = frequency + k1 * (1 - b + b * (item.tokens.length / averageLength));
        score += idf * ((frequency * (k1 + 1)) / denominator);
      }

      return {
        chunk: item.chunk,
        score,
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function normalizeScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score) || maxScore <= 0) {
    return 0;
  }

  return score / maxScore;
}

function maxScore(results: RagQueryResult[]): number {
  return Math.max(0, ...results.map((result) => result.score));
}

function computeRerankScore(questionTokens: string[], chunk: RagChunk): number {
  const uniqueQueryTokens = [...new Set(questionTokens)];
  if (uniqueQueryTokens.length === 0) {
    return 0;
  }

  const chunkText = chunk.text.toLowerCase();
  const matchedTokens = uniqueQueryTokens.filter((token) => chunkText.includes(token)).length;
  const exactQuestionBonus = chunkText.includes(questionTokens.join('')) ? 0.15 : 0;
  const sourceBonus = chunk.sourceType === 'jd' ? 0.05 : 0;
  return Math.min(1, (matchedTokens / uniqueQueryTokens.length) + exactQuestionBonus + sourceBonus);
}

function stableRank(results: RagQueryResult[]): Map<string, number> {
  const ranks = new Map<string, number>();
  results.forEach((result, index) => {
    if (!ranks.has(result.chunk.chunkId)) {
      ranks.set(result.chunk.chunkId, index + 1);
    }
  });
  return ranks;
}

export function hybridSearch(options: HybridSearchOptions): RagQueryResult[] {
  if (options.limit <= 0) {
    return [];
  }

  const keywordLimit = options.keywordLimit ?? options.limit * DEFAULT_KEYWORD_LIMIT_MULTIPLIER;
  const rerankCandidateLimit = options.rerankCandidateLimit ?? options.limit * DEFAULT_RERANK_CANDIDATE_MULTIPLIER;
  const weights = {
    ...DEFAULT_WEIGHTS,
    ...options.weights,
  };

  const denseResults = options.denseResults.filter((result) => matchesFilter(result.chunk, options.filter));
  const keywordResults = keywordSearch(options.question, options.chunks, options.filter, keywordLimit);
  const denseRanks = stableRank(denseResults);
  const keywordRanks = stableRank(keywordResults);
  const denseMaxScore = maxScore(denseResults);
  const keywordMaxScore = maxScore(keywordResults);
  const byChunkId = new Map<string, {
    chunk: RagChunk;
    denseScore: number;
    keywordScore: number;
    denseRank?: number;
    keywordRank?: number;
  }>();

  for (const result of denseResults) {
    const existing = byChunkId.get(result.chunk.chunkId);
    byChunkId.set(result.chunk.chunkId, {
      chunk: result.chunk,
      denseScore: Math.max(existing?.denseScore ?? 0, result.score),
      keywordScore: existing?.keywordScore ?? 0,
      denseRank: denseRanks.get(result.chunk.chunkId),
      keywordRank: existing?.keywordRank,
    });
  }

  for (const result of keywordResults) {
    const existing = byChunkId.get(result.chunk.chunkId);
    byChunkId.set(result.chunk.chunkId, {
      chunk: result.chunk,
      denseScore: existing?.denseScore ?? 0,
      keywordScore: Math.max(existing?.keywordScore ?? 0, result.score),
      denseRank: existing?.denseRank,
      keywordRank: keywordRanks.get(result.chunk.chunkId),
    });
  }

  const questionTokens = tokenize(options.question);
  return [...byChunkId.values()]
    .map((item) => {
      const denseRrf = item.denseRank ? 1 / (RRF_K + item.denseRank) : 0;
      const keywordRrf = item.keywordRank ? 1 / (RRF_K + item.keywordRank) : 0;
      const denseScore = normalizeScore(item.denseScore, denseMaxScore);
      const keywordScore = normalizeScore(item.keywordScore, keywordMaxScore);
      const rerankScore = computeRerankScore(questionTokens, item.chunk);
      const score = weights.dense * (denseScore + denseRrf)
        + weights.keyword * (keywordScore + keywordRrf)
        + weights.rerank * rerankScore;

      return {
        chunk: item.chunk,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.chunk.chunkId.localeCompare(right.chunk.chunkId);
    })
    .slice(0, rerankCandidateLimit)
    .slice(0, options.limit);
}

# RAG Instructions

These instructions apply to persisted RAG, retrieval, answering, ingestion, diagnostics, and quality
loops under `src/rag/`. CLI/scripts and server routes that call this code must preserve the same
contracts.

## Source of Truth and Isolation

- Persisted RAG data lives under `data/<platform>/jobs/<jobKey>/rag/`.
- Local JSONL files are authoritative. Qdrant is a rebuildable index and must never become the only
  copy of JD facts, chunks, conversations, embeddings, or answer logs.
- Every retrieval and vector operation must preserve both platform and job isolation through
  metadata filtering.
- Local embedding cache keys include provider, model, and content hash.

Expected local layout:

- `sources.jsonl`: JD and verified conversation source records.
- `chunks.jsonl`: factual chunks used to rebuild retrieval indexes.
- `embeddings.jsonl`: local embedding cache.
- `conversations/<conversationId>.jsonl`: deduplicated full conversation turns.
- `index-manifest.json`: latest index-build summary.
- `answer-logs.jsonl`: production candidate-facing answers, confidence, sources, no-answer reasons,
  and human feedback.

## Trusted Facts

- Store full conversation turns for context and audit.
- Only `role: recruiter` with `verified: true` may become an indexed factual chunk.
- Candidate turns and unverified recruiter turns are not answer facts.
- JD and verified recruiter facts may answer future candidate questions only within their platform
  and job scope.

## Retrieval and Answers

- Hybrid retrieval is the default (`RAG_RETRIEVAL_MODE=hybrid`): dense Qdrant recall plus local BM25
  recall, fusion, and lightweight reranking.
- `dense` mode is a diagnostic/override path, not the product default.
- If no trusted JD or verified conversation chunk meets the confidence threshold, return an explicit
  no-answer result. Do not call the model to speculate.
- `RAG_MODEL` is optional; when unset, use `OPENAI_MODEL`.
- Stored-job answers use persisted RAG and must not reparse JD.
- Temporary `--jd` or `--jd-file` answers use only the supplied JD. They must not create a job,
  persistent index, or production answer log.

## Production Logs vs Offline Quality Loops

- Production stored-job answers may append `answer-logs.jsonl` according to the answer path.
- Offline baseline, eval, answer-eval, and regression paths must never append production answer logs.
- Feedback, review, metrics, ops, eval, answer-eval, and regression are operational quality loops;
  preserve their offline/production boundary.
- No-answer and failure cases must retain reasons and source/confidence evidence without invented
  content.

## API Boundary

- `rag:api` is an internal product interface. It may require `RAG_API_KEY` or `--api-key`.
- It is not a complete auth gateway. Multi-tenancy, RBAC, rate limiting, centralized audit,
  monitoring alerts, and front-end management belong upstream or in later product layers.
- Console request-scoped model overrides apply only to assistant drafts and console RAG answers.
  Never persist/log the API key or include it in model input.

## Runtime Defaults

- `QDRANT_URL` points to Qdrant.
- `RAG_VECTOR_COLLECTION` defaults to `autorecruit_rag_chunks`.
- `RAG_EMBEDDING_PROVIDER` defaults to `local-http`.
- `RAG_EMBEDDING_LOCAL_URL` defaults to `http://127.0.0.1:8011`.
- `RAG_EMBEDDING_MODEL` defaults to `BAAI/bge-small-zh-v1.5`.
- Set `RAG_EMBEDDING_PROVIDER=openai` only when intentionally switching providers.

On this machine, long-running local services use LaunchAgents `com.autorecruit.qdrant` and
`com.autorecruit.embedding`. Embedding runtime files live under
`~/.local/share/autorecruit/embedding/`, with logs under `~/.local/var/log/autorecruit/`; avoid
`~/Documents` for background runtime data because of macOS privacy restrictions.

Health checks:

- `rtk launchctl list | rtk rg 'com\.autorecruit\.(qdrant|embedding)'`
- `rtk curl -sSf http://127.0.0.1:6333/collections`
- `rtk curl -sSf http://127.0.0.1:8011/health`

## Focused Verification

Use the matching tests under `src/scripts/test-rag-*.ts`. Common quality checks include:

- `rtk npm run test:rag:offline`
- `rtk npm run rag:doctor -- --platform <platform> --keyword "<keyword>"`
- `rtk npm run rag:eval -- --platform <platform> --keyword "<keyword>" --eval-file ./rag-eval.json`
- `rtk npm run rag:answer-eval -- --platform <platform> --keyword "<keyword>" --eval-file ./rag-answer-eval.json`
- `rtk npm run rag:regression -- --suite-file ./fixtures/rag/regression.json`

# RAG Instructions

## Scope and Inheritance

These instructions apply to persisted RAG, retrieval, answering, ingestion, diagnostics, and quality
loops under src/rag/. Apply root AGENTS.md first. CLI/scripts and server routes that call this code
also preserve these contracts; read src/server/AGENTS.md for HTTP, assistant, and queue behavior.

## Ownership and Boundaries

- Persisted RAG data lives under data/<platform>/jobs/<jobKey>/rag/. Local JSONL is authoritative;
  Qdrant is rebuildable and never the only copy of facts, chunks, conversations, embeddings, or
  answer logs.
- Retrieval/vector work preserves platform and job isolation through metadata filtering. Local
  embedding cache keys include provider, model, and content hash.
- RAG owns fact trust, indexing, retrieval, answer/no-answer semantics, local quality artifacts, and
  offline/production log boundaries. It does not broaden console authorization or execute tasks.

## Trusted Facts and Answers

- Store full conversation turns for context and audit, but only verified recruiter turns may become
  indexed factual chunks. Candidate and unverified recruiter turns are not answer facts.
- JD and verified recruiter facts answer only within their platform/job scope.
- Hybrid retrieval is the default. Dense-only retrieval is diagnostic. No trusted source or
  insufficient confidence returns an explicit no-answer result and never calls a model to speculate.
- Stored-job answers reuse persisted RAG without JD reparsing. Temporary JD answers use only the
  supplied JD and create no job, persistent index, or production answer log.

## Quality, API, and Runtime

- Production stored-job answers may append answer logs according to the answer path. Offline
  baseline, eval, answer-eval, and regression never append production logs; retain no-answer/failure
  reasons and evidence without invented content.
- rag:api is an internal interface, not a complete authentication gateway. Request-scoped console
  model settings apply only to assistant drafts and console RAG answers; never persist/log an API key
  or include it in model input.
- Runtime defaults, local-service locations, health checks, and provider selection follow README.md,
  项目说明文档.md, configuration, and deployment scripts. Do not copy machine-specific inventories
  into this scoped contract.

## Verification

- Use the matching src/scripts/test-rag-*.ts tests.
- Common focused checks: npm run test:rag:offline and the documented rag doctor, eval,
  answer-eval, and regression commands.
- Run npm run typecheck after RAG/server contract changes and expand to npm run test and npm run
  build when persistence, retrieval, answer, or API behavior changes.

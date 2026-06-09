# RAG Regression Fixtures

This directory contains the first small RAG regression baseline.

Run the full portable baseline:

```bash
rtk npm run rag:baseline
```

`rag:baseline` seeds the checked-in fixture job and conversation fixtures into local `data/`, builds the RAG index, then runs `fixtures/rag/regression.json`. It requires embedding and Qdrant configuration.

Run the deterministic offline baseline for CI:

```bash
rtk npm run test:rag:offline
```

`test:rag:offline` runs `rag:baseline:offline`. It seeds the same fixture job into a temporary data directory by default, uses an in-memory vector store and deterministic fake embeddings, and runs retrieval regression only. It does not require OpenAI, local embedding services, or Qdrant, and it skips answer generation/evaluation.

The CI command prints a compact summary by passing `--summary-only true`. Use `rtk npm run rag:baseline:offline -- --output-file tmp/rag-baseline-offline.json` when you want the full JSON result, or add `--data-dir /path/to/debug-data` when you also want to keep the seeded local RAG artifacts.

If you only want to write the fixture `jd.json` and load conversation fixtures without calling embedding/Qdrant, run seed alone:

```bash
rtk npm run rag:seed-fixtures
```

By default, seeding skips an existing local job record. Use `--overwrite true` only when you intentionally want to replace the local fixture job record.

Conversation fixtures live under `fixtures/rag/conversations/<platform>/<jobKey>/<conversationId>.json`. They are ingested like production conversations: turns are merged by stable turn id, the conversation facts are reindexed, only verified recruiter turns are indexed as facts, and unverified turns remain stored context that must not answer candidate questions.

The baseline covers salary, location, education, experience, language requirements, responsibilities, schedule requirements, one verified conversation fact about housing allowance, one unverified conversation no-answer case, and one JD no-answer case.

## Example templates

This directory also includes small copyable templates for RAG operations:

- `rag-review-jobs.example.json`: job list for `rag:review:batch`, `rag:doctor:batch`, `rag:metrics`, and the combined `rag:ops` report.
- `rag-metrics-policy.example.json`: quality gate thresholds for `rag:metrics --policy`, including high-risk feedback error type rates.
- `conversation-import.example.jsonl`: JSONL input shape for `rag:ingest-conversations`.

Use copies of these files for real jobs. Keep production candidate conversations out of checked-in fixtures unless they are fully desensitized.

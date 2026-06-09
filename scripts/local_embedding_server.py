#!/usr/bin/env python3
"""Local FastEmbed HTTP service for autorecruit RAG embeddings."""

from __future__ import annotations

import argparse
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8011


def _load_dotenv_file() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ[key] = value


_load_dotenv_file()


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[str] = Field(..., min_length=1)


class EmbeddingResponseItem(BaseModel):
    index: int
    embedding: list[float]


class EmbeddingResponse(BaseModel):
    object: str = "list"
    model: str
    data: list[EmbeddingResponseItem]


def _resolve_default_model() -> str:
    return os.getenv("RAG_EMBEDDING_MODEL") or os.getenv("EMBEDDING_MODEL") or DEFAULT_MODEL


@lru_cache(maxsize=4)
def _load_model(model_name: str) -> Any:
    from fastembed import TextEmbedding

    cache_dir = os.getenv("FASTEMBED_CACHE_DIR") or None
    threads = os.getenv("FASTEMBED_THREADS")
    thread_count = int(threads) if threads else None
    return TextEmbedding(model_name=model_name, cache_dir=cache_dir, threads=thread_count)


def _normalise_input(value: str | list[str]) -> list[str]:
    if isinstance(value, str):
        return [value]
    return value


def create_app() -> FastAPI:
    app = FastAPI(title="autorecruit local embedding service")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {
            "status": "ok",
            "defaultModel": _resolve_default_model(),
        }

    @app.post("/embeddings", response_model=EmbeddingResponse)
    async def embeddings(payload: EmbeddingRequest, request: Request) -> EmbeddingResponse:
        expected_token = os.getenv("RAG_EMBEDDING_LOCAL_API_KEY") or os.getenv("EMBEDDING_LOCAL_API_KEY")
        if expected_token:
            auth = request.headers.get("authorization", "")
            if auth != f"Bearer {expected_token}":
                raise HTTPException(status_code=401, detail="invalid bearer token")

        model_name = (payload.model or _resolve_default_model()).strip()
        if not model_name:
            raise HTTPException(status_code=400, detail="model is required")

        texts = _normalise_input(payload.input)
        if not texts:
            raise HTTPException(status_code=400, detail="input must not be empty")

        try:
            model = _load_model(model_name)
            vectors = [vector.tolist() for vector in model.embed(texts)]
        except Exception as exc:  # noqa: BLE001 - return HTTP-safe error text.
            raise HTTPException(status_code=500, detail=f"embedding failed: {exc}") from exc

        if len(vectors) != len(texts):
            raise HTTPException(status_code=500, detail=f"model returned {len(vectors)} vectors for {len(texts)} inputs")

        return EmbeddingResponse(
            model=model_name,
            data=[
                EmbeddingResponseItem(index=index, embedding=[float(value) for value in vector])
                for index, vector in enumerate(vectors)
            ],
        )

    return app


app = create_app()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the autorecruit local embedding HTTP service.")
    parser.add_argument("--host", default=os.getenv("RAG_EMBEDDING_LOCAL_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.getenv("RAG_EMBEDDING_LOCAL_PORT", str(DEFAULT_PORT))))
    parser.add_argument("--model", default=_resolve_default_model())
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.environ.setdefault("RAG_EMBEDDING_MODEL", args.model)

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()

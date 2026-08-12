"""Shared helpers for the Python side of the parity suite.

Everything both the writer and the reader need lives here so the two sides
cannot drift: fixture loading, the deterministic embedding, connection
plumbing, and the suffixes that scope one run.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Iterable

FIXTURES = json.loads(
    (Path(__file__).resolve().parent.parent / "fixtures" / "cases.json").read_text(
        encoding="utf-8"
    )
)

EMBED_DIMS: int = FIXTURES["embedding"]["dims"]


def conn_string() -> str:
    """Build Python's `user/password@dsn` connection string from the env."""
    user = require_env("ORACLE_USER")
    password = require_env("ORACLE_PASSWORD")
    dsn = require_env("ORACLE_CONNECT_STRING")
    return f"{user}/{password}@{dsn}"


def connect_kwargs() -> dict[str, str]:
    return {
        "user": require_env("ORACLE_USER"),
        "password": require_env("ORACLE_PASSWORD"),
        "dsn": require_env("ORACLE_CONNECT_STRING"),
    }


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Source parity/sh/lib.sh or export it before running."
        )
    return value


def run_suffix() -> str:
    """Suffix shared by every artefact of one run, chosen by the shell driver."""
    return require_env("PARITY_SUFFIX")


def checkpoint_suffix(direction: str) -> str:
    """Checkpoint tables are per direction so the two halves cannot collide."""
    return f"{run_suffix()}_{direction}"


def store_suffix(direction: str, flavour: str = "kv") -> str:
    return f"{run_suffix()}_{direction}_{flavour}"


def thread_id(direction: str, base: str) -> str:
    """Namespace thread ids by direction so both halves can run against one schema."""
    return f"{direction}:{base}"


def embed(text: str) -> list[float]:
    """Deterministic embedding, mirrored exactly in `js/src/common.ts`.

    Buckets code points and L2-normalises. No model, no network, and identical
    output in both languages, which is what makes a cross-language ranking
    comparison meaningful.
    """
    vector = [0.0] * EMBED_DIMS
    for char in text:
        vector[ord(char) % EMBED_DIMS] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return vector
    return [value / norm for value in vector]


class ParityEmbeddings:
    """Minimal LangChain-compatible embeddings wrapper around `embed`."""

    def embed_documents(self, texts: Iterable[str]) -> list[list[float]]:
        return [embed(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return embed(text)

    async def aembed_documents(self, texts: Iterable[str]) -> list[list[float]]:
        return self.embed_documents(texts)

    async def aembed_query(self, text: str) -> list[float]:
        return self.embed_query(text)


def index_config() -> dict[str, Any]:
    """Index configuration used by both languages for the vector cases."""
    return {
        "dims": EMBED_DIMS,
        "embed": ParityEmbeddings(),
        "fields": ["text"],
        "index_type": {"type": "ivf", "neighbor_partitions": 1},
    }


def whole_document_index_config() -> dict[str, Any]:
    """Default `fields` so get_text_at_path serialisation itself is compared."""
    return {
        "dims": EMBED_DIMS,
        "embed": ParityEmbeddings(),
        "index_type": {"type": "ivf", "neighbor_partitions": 1},
    }


def as_tuple(namespace: list[str]) -> tuple[str, ...]:
    return tuple(namespace)


def sorted_keys(items: Iterable[Any]) -> list[str]:
    return sorted(item.key for item in items)


def report(step: str, detail: str = "") -> None:
    suffix = f" {detail}" if detail else ""
    print(f"[python] {step}{suffix}", flush=True)

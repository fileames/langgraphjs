"""Write every fixture from Python so the JavaScript side can read it back.

Run with PARITY_DIRECTION=py2js. Table suffixes and thread ids are scoped to
that direction, so this half never touches what the JavaScript writer produced.
"""

from __future__ import annotations

import sys

from langgraph_oracledb.checkpoint.oracle import OracleSaver
from langgraph_oracledb.store.oracle import OracleStore

from common import (
    FIXTURES,
    as_tuple,
    checkpoint_suffix,
    conn_string,
    index_config,
    report,
    store_suffix,
    thread_id,
    whole_document_index_config,
)

DIRECTION = "py2js"


def write_checkpoints() -> None:
    # The Python saver has no table_suffix option yet, so this half runs
    # against the bare CHECKPOINTS tables. Thread ids are scoped instead.
    with OracleSaver.from_conn_string(conn_string(), json_size_threshold_mb=0) as saver:
        saver.setup()

        for thread in FIXTURES["checkpoints"]["threads"]:
            config = {
                "configurable": {
                    "thread_id": thread_id(DIRECTION, thread["id"]),
                    "checkpoint_ns": thread["checkpoint_ns"],
                }
            }
            if thread.get("parent_checkpoint_id"):
                config["configurable"]["checkpoint_id"] = thread[
                    "parent_checkpoint_id"
                ]

            checkpoint = {
                "v": 4,
                "id": thread["checkpoint_id"],
                "ts": "2024-07-31T20:14:19.804150+00:00",
                "channel_values": dict(thread["channel_values"]),
                "channel_versions": {
                    channel: "00000000000000000000000000000001.0"
                    for channel in thread["channel_values"]
                },
                "versions_seen": {},
            }
            new_versions = dict(checkpoint["channel_versions"])
            saver.put(config, checkpoint, dict(thread["metadata"]), new_versions)
            report("wrote checkpoint", thread["id"])

        for write in FIXTURES["checkpoints"]["writes"]:
            config = {
                "configurable": {
                    "thread_id": thread_id(DIRECTION, write["thread_id"]),
                    "checkpoint_ns": write["checkpoint_ns"],
                    "checkpoint_id": write["checkpoint_id"],
                }
            }
            saver.put_writes(
                config,
                [(channel, value) for channel, value in write["writes"]],
                write["task_id"],
                write["task_path"],
            )
            report("wrote pending writes", write["task_id"])

        # Binary payloads exercise the BLOB path in both languages.
        binary_config = {
            "configurable": {
                "thread_id": thread_id(DIRECTION, "parity-binary"),
                "checkpoint_ns": "",
            }
        }
        binary_checkpoint = {
            "v": 4,
            "id": "1ef4f797-8335-6428-8001-8a1503f9b899",
            "ts": "2024-07-31T20:14:19.804150+00:00",
            "channel_values": {
                "bytes": b"\x00\x01\x02\xfe\xff binary payload",
                "empty_bytes": b"",
                "large_text": "x" * 200_000,
            },
            "channel_versions": {
                "bytes": "00000000000000000000000000000001.0",
                "empty_bytes": "00000000000000000000000000000001.0",
                "large_text": "00000000000000000000000000000001.0",
            },
            "versions_seen": {},
        }
        saver.put(
            binary_config,
            binary_checkpoint,
            {"source": "parity", "step": 4},
            dict(binary_checkpoint["channel_versions"]),
        )
        report("wrote binary checkpoint")


def write_store() -> None:
    suffix = store_suffix(DIRECTION)
    with OracleStore.from_conn_string(conn_string(), table_suffix=suffix) as store:
        store.setup()
        for item in FIXTURES["store"]["items"]:
            store.put(as_tuple(item["namespace"]), item["key"], item["value"])
            report("wrote store item", f'{item["namespace"]}/{item["key"]}')

        # TTL rows: one that stays live for the reader, one already expired.
        store.put(("parity", "ttl"), "live", {"text": "still valid"}, ttl=60)
        store.put(("parity", "ttl"), "expiring", {"text": "short lived"}, ttl=1)
        report("wrote ttl items")


def write_vector_store() -> None:
    suffix = store_suffix(DIRECTION, "vec")
    with OracleStore.from_conn_string(
        conn_string(), index=index_config(), table_suffix=suffix
    ) as store:
        store.setup()
        for item in FIXTURES["vector_store"]["items"]:
            kwargs = {}
            if item.get("index") is False:
                kwargs["index"] = False
            store.put(as_tuple(item["namespace"]), item["key"], item["value"], **kwargs)
            report("wrote vector item", item["key"])


def write_whole_document_store() -> None:
    """Same documents indexed with the default fields, to compare serialisation."""
    suffix = store_suffix(DIRECTION, "doc")
    with OracleStore.from_conn_string(
        conn_string(), index=whole_document_index_config(), table_suffix=suffix
    ) as store:
        store.setup()
        store.put(
            ("parity", "whole"),
            "doc",
            {"beta": "second", "alpha": "first", "count": 2},
        )
        report("wrote whole-document item")


def write_derived_suffix_store() -> None:
    """No explicit suffix: both languages must derive the same table names."""
    with OracleStore.from_conn_string(conn_string(), index=index_config()) as store:
        store.setup()
        store.put(
            ("parity", "derived", DIRECTION),
            "doc",
            {"text": "apple banana fruit"},
        )
        report("wrote derived-suffix item", store.table_suffix or "?")


def main() -> int:
    write_checkpoints()
    write_store()
    write_vector_store()
    write_whole_document_store()
    write_derived_suffix_store()
    report("write phase complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())

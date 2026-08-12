"""Read back, from Python, everything the JavaScript writer produced.

Runs with PARITY_DIRECTION=js2py after `js/src/write.ts` has finished.
"""

from __future__ import annotations

import pytest
from langgraph_oracledb.checkpoint.oracle import OracleSaver
from langgraph_oracledb.store.oracle import OracleStore

from common import (
    FIXTURES,
    as_tuple,
    conn_string,
    index_config,
    store_suffix,
    thread_id,
    whole_document_index_config,
)

DIRECTION = "js2py"


@pytest.fixture(scope="module")
def saver():
    with OracleSaver.from_conn_string(conn_string(), json_size_threshold_mb=0) as s:
        s.setup()
        yield s


@pytest.fixture(scope="module")
def kv_store():
    with OracleStore.from_conn_string(
        conn_string(), table_suffix=store_suffix(DIRECTION)
    ) as s:
        s.setup()
        yield s


@pytest.fixture(scope="module")
def vector_store():
    with OracleStore.from_conn_string(
        conn_string(), index=index_config(), table_suffix=store_suffix(DIRECTION, "vec")
    ) as s:
        s.setup()
        yield s


def config_for(base: str, checkpoint_ns: str = "", checkpoint_id: str | None = None):
    configurable = {
        "thread_id": thread_id(DIRECTION, base),
        "checkpoint_ns": checkpoint_ns,
    }
    if checkpoint_id:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


# --------------------------------------------------------------------------
# Checkpoints
# --------------------------------------------------------------------------


@pytest.mark.parametrize("thread", FIXTURES["checkpoints"]["threads"])
def test_checkpoint_round_trips(saver, thread):
    tuple_ = saver.get_tuple(
        config_for(thread["id"], thread["checkpoint_ns"], thread["checkpoint_id"])
    )
    assert tuple_ is not None, f"missing checkpoint for {thread['id']}"

    for channel, expected in thread["channel_values"].items():
        assert tuple_.checkpoint["channel_values"][channel] == expected, channel


def test_checkpoint_namespace_round_trips(saver):
    thread = FIXTURES["checkpoints"]["threads"][1]
    tuple_ = saver.get_tuple(
        config_for(thread["id"], thread["checkpoint_ns"], thread["checkpoint_id"])
    )
    assert tuple_ is not None
    # The empty-string sentinel must not leak into the public config.
    assert tuple_.config["configurable"]["checkpoint_ns"] == thread["checkpoint_ns"]


def test_empty_checkpoint_namespace_round_trips(saver):
    thread = FIXTURES["checkpoints"]["threads"][0]
    tuple_ = saver.get_tuple(config_for(thread["id"], "", thread["checkpoint_id"]))
    assert tuple_ is not None
    assert tuple_.config["configurable"]["checkpoint_ns"] == ""


def test_metadata_round_trips(saver):
    thread = FIXTURES["checkpoints"]["threads"][0]
    tuple_ = saver.get_tuple(config_for(thread["id"], "", thread["checkpoint_id"]))
    assert tuple_ is not None
    for key, expected in thread["metadata"].items():
        assert tuple_.metadata[key] == expected, key
    # Oracle JSON returns Decimal; the saver must hand back plain ints.
    assert isinstance(tuple_.metadata["step"], int)


def test_parent_lineage_round_trips(saver):
    thread = FIXTURES["checkpoints"]["threads"][2]
    tuple_ = saver.get_tuple(config_for(thread["id"], "", thread["checkpoint_id"]))
    assert tuple_ is not None
    assert tuple_.parent_config is not None
    assert (
        tuple_.parent_config["configurable"]["checkpoint_id"]
        == thread["parent_checkpoint_id"]
    )


def test_pending_writes_round_trip(saver):
    thread = FIXTURES["checkpoints"]["threads"][0]
    tuple_ = saver.get_tuple(config_for(thread["id"], "", thread["checkpoint_id"]))
    assert tuple_ is not None

    observed = [(task_id, channel, value) for task_id, channel, value in tuple_.pending_writes]
    expected = []
    for write in FIXTURES["checkpoints"]["writes"]:
        for channel, value in write["writes"]:
            expected.append((write["task_id"], channel, value))

    assert sorted(observed) == sorted(expected)


def test_binary_channel_values_round_trip(saver):
    binary = FIXTURES["checkpoints"]["binary"]
    tuple_ = saver.get_tuple(
        config_for(binary["thread_id"], "", binary["checkpoint_id"])
    )
    assert tuple_ is not None
    values = tuple_.checkpoint["channel_values"]
    assert list(values["bytes"]) == binary["bytes"]
    assert values["empty_bytes"] == b""
    assert values["large_text"] == (
        binary["large_text_char"] * binary["large_text_length"]
    )


def test_list_returns_written_checkpoints(saver):
    config = {"configurable": {"thread_id": thread_id(DIRECTION, "parity-basic")}}
    listed = list(saver.list(config))
    assert len(listed) >= 1
    ids = {item.config["configurable"]["checkpoint_id"] for item in listed}
    assert "1ef4f797-8335-6428-8001-8a1503f9b875" in ids


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


@pytest.mark.parametrize("item", FIXTURES["store"]["items"])
def test_store_item_round_trips(kv_store, item):
    stored = kv_store.get(as_tuple(item["namespace"]), item["key"])
    assert stored is not None, f"missing {item['namespace']}/{item['key']}"
    assert stored.value == item["value"]


@pytest.mark.parametrize("case", FIXTURES["store"]["filters"])
def test_store_filters(kv_store, case):
    results = kv_store.search(
        ("parity", "basic"), filter=case["filter"], limit=10
    )
    assert sorted(item.key for item in results) == sorted(case["expect_keys"]), (
        case["name"]
    )


@pytest.mark.parametrize("case", FIXTURES["store"]["namespace_prefixes"])
def test_store_namespace_prefix_search(kv_store, case):
    results = kv_store.search(as_tuple(case["prefix"]), limit=10)
    assert sorted(item.key for item in results) == sorted(case["expect_keys"])


def test_list_namespaces(kv_store):
    namespaces = kv_store.list_namespaces(prefix=("parity",), limit=100)
    # list_namespaces may hand back lists or tuples depending on the driver
    # path, so normalise before comparing.
    observed = {tuple(namespace) for namespace in namespaces}
    assert ("parity", "basic") in observed
    assert ("parity", "deep", "a", "b", "c") in observed


# --------------------------------------------------------------------------
# Vector search
# --------------------------------------------------------------------------


@pytest.mark.parametrize("case", FIXTURES["vector_store"]["queries"])
def test_vector_search_ranking(vector_store, case):
    results = vector_store.search(
        ("parity", "vectors"), query=case["query"], limit=5
    )
    assert results, "no vector results"
    assert results[0].key == case["expect_first"]


def test_unindexed_item_absent_from_vector_search(vector_store):
    results = vector_store.search(
        ("parity", "vectors"), query="apple banana fruit", limit=10
    )
    assert "unindexed" not in {item.key for item in results}


def test_whole_document_embedding_matches():
    """The default `fields` path depends on get_text_at_path serialisation.

    If the two languages serialise the document differently the vectors differ,
    and the identical query stops matching exactly.
    """
    with OracleStore.from_conn_string(
        conn_string(),
        index=whole_document_index_config(),
        table_suffix=store_suffix(DIRECTION, "doc"),
    ) as store:
        store.setup()
        import json

        document = {"beta": "second", "alpha": "first", "count": 2}
        query = json.dumps(document, sort_keys=True, ensure_ascii=False)
        results = store.search(("parity", "whole"), query=query, limit=1)
        assert results, "no whole-document results"
        assert results[0].key == "doc"
        # An exact text match must score at the cosine maximum.
        assert results[0].score is not None
        assert results[0].score > 0.999

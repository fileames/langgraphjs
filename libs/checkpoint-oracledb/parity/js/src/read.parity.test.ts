// Copyright (c) 2026, Oracle and/or its affiliates.
//
// Read back, from JavaScript, everything the Python writer produced.
// Runs with PARITY_DIRECTION=py2js after `python/write.py` has finished.
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { OracleCheckpointSaver } from "../../../src/saver.js";
import { OracleStore } from "../../../src/store/index.js";
import {
  FIXTURES,
  indexConfig,
  oracleConnection,
  storeSuffix,
  threadId,
  wholeDocumentIndexConfig,
} from "./common.js";

const DIRECTION = "py2js";

let saver: OracleCheckpointSaver;
let kvStore: OracleStore;
let vectorStore: OracleStore;

beforeAll(async () => {
  saver = new OracleCheckpointSaver({
    connection: oracleConnection(),
    jsonSizeThresholdMb: 0,
  });
  await saver.setup();

  kvStore = new OracleStore({
    connection: oracleConnection(),
    tableSuffix: storeSuffix(DIRECTION),
  });
  await kvStore.setup();

  vectorStore = new OracleStore({
    connection: oracleConnection(),
    index: indexConfig(),
    tableSuffix: storeSuffix(DIRECTION, "vec"),
  });
  await vectorStore.setup();
});

afterAll(async () => {
  await saver?.end();
  await kvStore?.stop();
  await vectorStore?.stop();
});

function configFor(base: string, checkpointNs = "", checkpointId?: string) {
  const configurable: Record<string, unknown> = {
    thread_id: threadId(DIRECTION, base),
    checkpoint_ns: checkpointNs,
  };
  if (checkpointId) configurable.checkpoint_id = checkpointId;
  return { configurable };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`expected binary channel value, got ${typeof value}`);
}

describe("checkpoints written by Python", () => {
  test.each(FIXTURES.checkpoints.threads)(
    "round-trips checkpoint $id",
    async (thread) => {
      const tuple = await saver.getTuple(
        configFor(thread.id, thread.checkpoint_ns, thread.checkpoint_id)
      );
      expect(tuple, `missing checkpoint for ${thread.id}`).toBeDefined();
      for (const [channel, expected] of Object.entries(thread.channel_values)) {
        expect(tuple!.checkpoint.channel_values[channel]).toEqual(expected);
      }
    }
  );

  test("preserves a non-empty checkpoint namespace", async () => {
    const thread = FIXTURES.checkpoints.threads[1];
    const tuple = await saver.getTuple(
      configFor(thread.id, thread.checkpoint_ns, thread.checkpoint_id)
    );
    expect(tuple?.config.configurable?.checkpoint_ns).toBe(
      thread.checkpoint_ns
    );
  });

  test("preserves an empty checkpoint namespace", async () => {
    const thread = FIXTURES.checkpoints.threads[0];
    // Both languages store "" as a single-space sentinel; it must not leak.
    const tuple = await saver.getTuple(
      configFor(thread.id, "", thread.checkpoint_id)
    );
    expect(tuple?.config.configurable?.checkpoint_ns).toBe("");
  });

  test("round-trips metadata including nested and unicode values", async () => {
    const thread = FIXTURES.checkpoints.threads[0];
    const tuple = await saver.getTuple(
      configFor(thread.id, "", thread.checkpoint_id)
    );
    expect(tuple).toBeDefined();
    for (const [key, expected] of Object.entries(thread.metadata)) {
      expect(tuple!.metadata?.[key as keyof typeof tuple.metadata]).toEqual(
        expected
      );
    }
  });

  test("round-trips parent lineage", async () => {
    const thread = FIXTURES.checkpoints.threads[2];
    const tuple = await saver.getTuple(
      configFor(thread.id, "", thread.checkpoint_id)
    );
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe(
      thread.parent_checkpoint_id
    );
  });

  test("round-trips pending writes from every task", async () => {
    const thread = FIXTURES.checkpoints.threads[0];
    const tuple = await saver.getTuple(
      configFor(thread.id, "", thread.checkpoint_id)
    );
    expect(tuple).toBeDefined();

    const observed = (tuple!.pendingWrites ?? []).map(
      ([taskId, channel, value]) => `${taskId}|${channel}|${String(value)}`
    );
    const expected = FIXTURES.checkpoints.writes.flatMap((write) =>
      write.writes.map(
        ([channel, value]) => `${write.task_id}|${channel}|${String(value)}`
      )
    );
    expect(observed.sort()).toEqual(expected.sort());
  });

  test("round-trips binary channel values", async () => {
    const tuple = await saver.getTuple(
      configFor("parity-binary", "", "1ef4f797-8335-6428-8001-8a1503f9b899")
    );
    expect(tuple).toBeDefined();
    const values = tuple!.checkpoint.channel_values;
    expect(Array.from(toBytes(values.bytes))).toEqual([0, 1, 2, 254, 255]);
    expect(toBytes(values.empty_bytes).byteLength).toBe(0);
    expect(values.large_text).toBe("x".repeat(200_000));
  });

  test("lists checkpoints written by Python", async () => {
    const listed = [];
    for await (const item of saver.list({
      configurable: { thread_id: threadId(DIRECTION, "parity-basic") },
    })) {
      listed.push(item);
    }
    expect(listed.length).toBeGreaterThanOrEqual(1);
    expect(
      listed.map((item) => item.config.configurable?.checkpoint_id)
    ).toContain("1ef4f797-8335-6428-8001-8a1503f9b875");
  });
});

describe("store items written by Python", () => {
  test.each(FIXTURES.store.items)(
    "round-trips $key",
    async (item) => {
      const stored = await kvStore.get(item.namespace, item.key);
      expect(stored, `missing ${item.namespace.join(".")}/${item.key}`).not
        .toBeNull();
      expect(stored!.value).toEqual(item.value);
    }
  );

  test.each(FIXTURES.store.filters)("filter $name", async (testCase) => {
    const results = await kvStore.search(["parity", "basic"], {
      filter: testCase.filter,
      limit: 10,
    });
    expect(results.map((item) => item.key).sort()).toEqual(
      [...testCase.expect_keys].sort()
    );
  });

  test.each(FIXTURES.store.namespace_prefixes)(
    "namespace prefix $prefix",
    async (testCase) => {
      const results = await kvStore.search(testCase.prefix, { limit: 10 });
      expect(results.map((item) => item.key).sort()).toEqual(
        [...testCase.expect_keys].sort()
      );
    }
  );

  test("lists namespaces written by Python", async () => {
    const namespaces = await kvStore.listNamespaces({
      prefix: ["parity"],
      limit: 100,
    });
    const encoded = namespaces.map((namespace) => namespace.join("."));
    expect(encoded).toContain("parity.basic");
    expect(encoded).toContain("parity.deep.a.b.c");
  });
});

describe("vector search over rows written by Python", () => {
  test.each(FIXTURES.vector_store.queries)(
    "ranks $expect_first first for $query",
    async (testCase) => {
      const results = await vectorStore.search(["parity", "vectors"], {
        query: testCase.query,
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].key).toBe(testCase.expect_first);
    }
  );

  test("excludes the item Python wrote with index=False", async () => {
    const results = await vectorStore.search(["parity", "vectors"], {
      query: "apple banana fruit",
      limit: 10,
    });
    expect(results.map((item) => item.key)).not.toContain("unindexed");
  });

  test("matches Python's whole-document embedding exactly", async () => {
    // The default `fields` path depends on get_text_at_path serialisation. If
    // the two languages serialise differently the vectors differ and the
    // identical query stops scoring at the cosine maximum.
    const store = new OracleStore({
      connection: oracleConnection(),
      index: wholeDocumentIndexConfig(),
      tableSuffix: storeSuffix(DIRECTION, "doc"),
    });
    try {
      await store.setup();
      const query = '{"alpha": "first", "beta": "second", "count": 2}';
      const results = await store.search(["parity", "whole"], {
        query,
        limit: 1,
      });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe("doc");
      expect(results[0].score).toBeGreaterThan(0.999);
    } finally {
      await store.stop();
    }
  });
});

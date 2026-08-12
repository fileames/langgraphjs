// Copyright (c) 2026, Oracle and/or its affiliates.
//
// Write every fixture from JavaScript so the Python side can read it back.
// Runs with PARITY_DIRECTION=js2py.
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

import { OracleCheckpointSaver } from "../../../src/saver.js";
import { OracleStore } from "../../../src/store/index.js";
import {
  FIXTURES,
  indexConfig,
  oracleConnection,
  report,
  storeSuffix,
  threadId,
  wholeDocumentIndexConfig,
} from "./common.js";

const DIRECTION = "js2py";

function channelVersions(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(values).map((channel) => [
      channel,
      "00000000000000000000000000000001.0",
    ])
  );
}

async function writeCheckpoints(): Promise<void> {
  // The Python saver has no table_suffix option yet, so this half uses the
  // bare CHECKPOINTS tables and scopes by thread id instead.
  const saver = new OracleCheckpointSaver({
    connection: oracleConnection(),
    jsonSizeThresholdMb: 0,
  });

  try {
    await saver.setup();

    for (const thread of FIXTURES.checkpoints.threads) {
      const configurable: Record<string, unknown> = {
        thread_id: threadId(DIRECTION, thread.id),
        checkpoint_ns: thread.checkpoint_ns,
      };
      if (thread.parent_checkpoint_id) {
        configurable.checkpoint_id = thread.parent_checkpoint_id;
      }

      const checkpoint = {
        v: 4,
        id: thread.checkpoint_id,
        ts: "2024-07-31T20:14:19.804150+00:00",
        channel_values: { ...thread.channel_values },
        channel_versions: channelVersions(thread.channel_values),
        versions_seen: {},
      } as unknown as Checkpoint;

      await saver.put(
        { configurable },
        checkpoint,
        thread.metadata as CheckpointMetadata,
        channelVersions(thread.channel_values)
      );
      report("wrote checkpoint", thread.id);
    }

    for (const write of FIXTURES.checkpoints.writes) {
      await saver.putWrites(
        {
          configurable: {
            thread_id: threadId(DIRECTION, write.thread_id),
            checkpoint_ns: write.checkpoint_ns,
            checkpoint_id: write.checkpoint_id,
          },
        },
        write.writes as Array<[string, unknown]>,
        write.task_id,
        write.task_path
      );
      report("wrote pending writes", write.task_id);
    }

    // Binary payloads exercise the BLOB path in both languages. The bytes
    // come from the fixtures so both writers send exactly the same thing.
    const binary = FIXTURES.checkpoints.binary;
    const binaryValues = {
      bytes: new Uint8Array(binary.bytes),
      empty_bytes: new Uint8Array(),
      large_text: binary.large_text_char.repeat(binary.large_text_length),
    };
    await saver.put(
      {
        configurable: {
          thread_id: threadId(DIRECTION, binary.thread_id),
          checkpoint_ns: "",
        },
      },
      {
        v: 4,
        id: binary.checkpoint_id,
        ts: "2024-07-31T20:14:19.804150+00:00",
        channel_values: binaryValues,
        channel_versions: channelVersions(binaryValues),
        versions_seen: {},
      } as unknown as Checkpoint,
      { source: "parity", step: 4 } as unknown as CheckpointMetadata,
      channelVersions(binaryValues)
    );
    report("wrote binary checkpoint");
  } finally {
    await saver.end();
  }
}

async function writeStore(): Promise<void> {
  const store = new OracleStore({
    connection: oracleConnection(),
    tableSuffix: storeSuffix(DIRECTION),
  });
  try {
    await store.setup();
    for (const item of FIXTURES.store.items) {
      await store.put(item.namespace, item.key, item.value);
      report("wrote store item", `${item.namespace.join(".")}/${item.key}`);
    }
    await store.put(["parity", "ttl"], "live", { text: "still valid" }, undefined, {
      ttl: 60,
    });
    await store.put(
      ["parity", "ttl"],
      "expiring",
      { text: "short lived" },
      undefined,
      { ttl: 1 }
    );
    report("wrote ttl items");
  } finally {
    await store.stop();
  }
}

async function writeVectorStore(): Promise<void> {
  const store = new OracleStore({
    connection: oracleConnection(),
    index: indexConfig(),
    tableSuffix: storeSuffix(DIRECTION, "vec"),
  });
  try {
    await store.setup();
    for (const item of FIXTURES.vector_store.items) {
      await store.put(
        item.namespace,
        item.key,
        item.value,
        item.index === false ? false : undefined
      );
      report("wrote vector item", item.key);
    }
  } finally {
    await store.stop();
  }
}

async function writeWholeDocumentStore(): Promise<void> {
  const store = new OracleStore({
    connection: oracleConnection(),
    index: wholeDocumentIndexConfig(),
    tableSuffix: storeSuffix(DIRECTION, "doc"),
  });
  try {
    await store.setup();
    await store.put(["parity", "whole"], "doc", {
      beta: "second",
      alpha: "first",
      count: 2,
    });
    report("wrote whole-document item");
  } finally {
    await store.stop();
  }
}

async function writeDerivedSuffixStore(): Promise<void> {
  // No explicit suffix: both languages must derive the same table names.
  const store = new OracleStore({
    connection: oracleConnection(),
    index: indexConfig(),
  });
  try {
    await store.setup();
    await store.put(["parity", "derived", DIRECTION], "doc", {
      text: "apple banana fruit",
    });
    report(
      "wrote derived-suffix item",
      (store as unknown as { tableSuffix: string }).tableSuffix
    );
  } finally {
    await store.stop();
  }
}

async function main(): Promise<void> {
  await writeCheckpoints();
  await writeStore();
  await writeVectorStore();
  await writeWholeDocumentStore();
  await writeDerivedSuffixStore();
  report("write phase complete");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

// Copyright (c) 2026, Oracle and/or its affiliates.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = JSON.parse(
  readFileSync(join(here, "..", "..", "fixtures", "cases.json"), "utf8")
) as Fixtures;

export const EMBED_DIMS: number = FIXTURES.embedding.dims;

export interface Fixtures {
  embedding: { dims: number };
  checkpoints: {
    threads: Array<{
      id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      parent_checkpoint_id?: string;
      channel_values: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>;
    writes: Array<{
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      task_id: string;
      task_path: string;
      writes: Array<[string, unknown]>;
    }>;
    binary: {
      thread_id: string;
      checkpoint_id: string;
      bytes: number[];
      large_text_char: string;
      large_text_length: number;
    };
  };
  store: {
    items: Array<{
      namespace: string[];
      key: string;
      value: Record<string, unknown>;
    }>;
    filters: Array<{
      name: string;
      filter: Record<string, unknown>;
      expect_keys: string[];
    }>;
    namespace_prefixes: Array<{ prefix: string[]; expect_keys: string[] }>;
  };
  vector_store: {
    items: Array<{
      namespace: string[];
      key: string;
      value: Record<string, unknown>;
      index?: false;
    }>;
    queries: Array<{ query: string; expect_first: string }>;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Source parity/sh/lib.sh or export it before running.`
    );
  }
  return value;
}

export function oracleConnection(): {
  user: string;
  password: string;
  connectString: string;
} {
  return {
    user: requireEnv("ORACLE_USER"),
    password: requireEnv("ORACLE_PASSWORD"),
    connectString: requireEnv("ORACLE_CONNECT_STRING"),
  };
}

/** Suffix shared by every artefact of one run, chosen by the shell driver. */
export function runSuffix(): string {
  return requireEnv("PARITY_SUFFIX");
}

export function storeSuffix(direction: string, flavour = "kv"): string {
  return `${runSuffix()}_${direction}_${flavour}`;
}

/** Thread ids are scoped by direction so both halves share one schema safely. */
export function threadId(direction: string, base: string): string {
  return `${direction}:${base}`;
}

/**
 * Deterministic embedding, mirrored exactly in `python/common.py`.
 *
 * Buckets code points and L2-normalises. Identical output in both languages is
 * what makes a cross-language ranking comparison meaningful.
 */
export function embed(text: string): number[] {
  const vector = new Array<number>(EMBED_DIMS).fill(0);
  for (const char of text) {
    vector[char.codePointAt(0)! % EMBED_DIMS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export const parityEmbeddings = {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embed(text));
  },
  async embedQuery(text: string): Promise<number[]> {
    return embed(text);
  },
};

/**
 * Index configuration used by both languages for the vector cases.
 *
 * No numeric `index_type` parameters on purpose: Python's
 * `_validate_configuration` json.dumps() the stored `index_params`, which come
 * back from the Oracle JSON column as `Decimal`, so any numeric parameter
 * makes a second `setup()` raise. See `python/known_bugs/`.
 */
export function indexConfig() {
  return {
    dims: EMBED_DIMS,
    embeddings: parityEmbeddings as never,
    fields: ["text"],
    index_type: { type: "ivf" as const },
  };
}

/** Default `fields` so get_text_at_path serialisation itself is compared. */
export function wholeDocumentIndexConfig() {
  return {
    dims: EMBED_DIMS,
    embeddings: parityEmbeddings as never,
    index_type: { type: "ivf" as const },
  };
}

export function report(step: string, detail = ""): void {
  console.log(`[js] ${step}${detail ? ` ${detail}` : ""}`);
}

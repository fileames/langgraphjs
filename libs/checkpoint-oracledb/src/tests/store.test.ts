// Copyright (c) 2026, Oracle and/or its affiliates.
import oracledb from "oracledb";
import { describe, expect, test, vi } from "vitest";
import type { IndexConfig } from "@langchain/langgraph-checkpoint";

import { OracleStore } from "../store/index.js";
import { ORACLE_VECTOR_MAX_DIMENSIONS } from "../store/constants.js";

const unusedPool = {
  async getConnection() {
    throw new Error("Oracle should not be called for validation failures.");
  },
};

class FakeSetupConnection {
  committed = false;

  rolledBack = false;

  constructor(
    private readonly options: {
      currentVersion: number;
      vectorVersion?: number;
      existingTables: Set<string>;
    }
  ) {}

  async execute<RowT = Record<string, unknown>>(
    sql: string,
    binds: Record<string, unknown> = {}
  ): Promise<{ rows?: RowT[] }> {
    if (/^\s*CREATE TABLE\b/i.test(sql)) {
      return {};
    }
    if (/SELECT v FROM/i.test(sql)) {
      return {
        rows: [
          {
            V: /VECTOR_MIGRATIONS/i.test(sql)
              ? (this.options.vectorVersion ?? this.options.currentVersion)
              : this.options.currentVersion,
          } as RowT,
        ],
      };
    }
    if (/FROM user_tables/i.test(sql)) {
      const tableName = String(binds.tableName ?? "").toUpperCase();
      return {
        rows: [
          {
            TABLE_EXISTS: this.options.existingTables.has(tableName) ? 1 : 0,
          } as RowT,
        ],
      };
    }
    throw new Error(`Unexpected setup SQL: ${sql}`);
  }

  async commit(): Promise<void> {
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }

  async close(): Promise<void> {}
}

function fakePool(connection: FakeSetupConnection) {
  return {
    async getConnection() {
      return connection;
    },
    async close() {},
  };
}

interface StoreStateProbe {
  setup(): Promise<void>;
  ensurePool(): Promise<unknown>;
  resolveVectorBindStrategy(
    connection: unknown,
    allowDmlProbe: boolean
  ): Promise<"native" | "string">;
  probeNativeVectorQueryBinding(connection: unknown): Promise<void>;
  validatePersistedVectorDistance(connection: unknown): Promise<void>;
  isSetup: boolean;
  setupPromise?: Promise<void>;
  poolPromise?: Promise<unknown>;
  vectorBindStrategy?: "native" | "string";
  nativeVectorDmlProbed: boolean;
  pool?: unknown;
  ownsPool: boolean;
  tableSuffix: string;
}

describe("OracleStore runtime validation", () => {
  test("rejects invalid TTL configuration and per-write TTL values", async () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new OracleStore({ ttl: { defaultTtl: ttl } })).toThrow(
        "ttl.defaultTtl must be a finite number greater than 0"
      );
      expect(
        () => new OracleStore({ ttl: { sweepIntervalMinutes: ttl } })
      ).toThrow(
        "ttl.sweepIntervalMinutes must be a finite number greater than 0"
      );
    }

    const store = new OracleStore({
      pool: unusedPool as never,
      ensureTable: false,
    });
    await expect(
      store.put(["ttl"], "item", { value: true }, undefined, { ttl: 0 })
    ).rejects.toThrow("put options.ttl must be a finite number greater than 0");
  });

  test("starts and stops the configured TTL sweeper", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeSetupConnection({
        currentVersion: 4,
        existingTables: new Set(["STORE_TTL_TIMER"]),
      });
      const store = new OracleStore({
        pool: fakePool(connection) as never,
        tableSuffix: "TTL_TIMER",
        ttl: { sweepIntervalMinutes: 5 },
      });

      const initialTimerCount = vi.getTimerCount();
      await store.start();
      expect(vi.getTimerCount()).toBe(initialTimerCount + 1);
      await store.stop();
      expect(vi.getTimerCount()).toBe(initialTimerCount);
    } finally {
      vi.useRealTimers();
    }
  });

  test("derives the same default vector suffix as Python OracleStore", () => {
    const store = new OracleStore({
      index: {
        dims: 2,
        fields: ["text"],
        embeddings: {
          async embedDocuments() {
            return [];
          },
          async embedQuery() {
            return [];
          },
        } as never,
      },
    });

    expect((store as unknown as StoreStateProbe).tableSuffix).toBe("403c86");
  });

  test("rejects incompatible Python vector distance configuration", async () => {
    const store = new OracleStore({ tableSuffix: "shared" });
    const probe = store as unknown as StoreStateProbe;
    const connection = {
      async execute() {
        return { rows: [{ DISTANCE_TYPE: "EUCLIDEAN" }] };
      },
    };

    await expect(
      probe.validatePersistedVectorDistance(connection)
    ).rejects.toThrow("currently supports COSINE only");
  });

  test("shares concurrent lazy pool creation", async () => {
    let resolvePool!: (pool: unknown) => void;
    const pendingPool = new Promise((resolve) => {
      resolvePool = resolve;
    });
    const pool = fakePool(
      new FakeSetupConnection({ currentVersion: 0, existingTables: new Set() })
    );
    const createPool = vi
      .spyOn(oracledb, "createPool")
      .mockReturnValue(pendingPool as never);
    const store = new OracleStore({ ensureTable: false });
    const probe = store as unknown as StoreStateProbe;

    const first = probe.ensurePool();
    const second = probe.ensurePool();
    resolvePool(pool);
    await Promise.all([first, second]);

    expect(createPool).toHaveBeenCalledTimes(1);
    await store.stop();
    createPool.mockRestore();
  });

  test("does not latch string vector binding after transient probe errors", async () => {
    const index = {
      dims: 2,
      embeddings: {
        async embedDocuments() {
          return [];
        },
        async embedQuery() {
          return [0, 0];
        },
      },
    } as unknown as IndexConfig;
    const transientStore = new OracleStore({ index });
    const transientProbe = transientStore as unknown as StoreStateProbe;
    transientProbe.probeNativeVectorQueryBinding = async () => {
      throw Object.assign(new Error("temporary connection failure"), {
        code: "NJS-500",
      });
    };

    await expect(
      transientProbe.resolveVectorBindStrategy({}, false)
    ).resolves.toBe("string");
    expect(transientProbe.vectorBindStrategy).toBeUndefined();

    const unsupportedStore = new OracleStore({ index });
    const unsupportedProbe = unsupportedStore as unknown as StoreStateProbe;
    unsupportedProbe.probeNativeVectorQueryBinding = async () => {
      throw Object.assign(new Error("invalid bind type"), { code: "NJS-012" });
    };
    await expect(
      unsupportedProbe.resolveVectorBindStrategy({}, false)
    ).resolves.toBe("string");
    expect(unsupportedProbe.vectorBindStrategy).toBe("string");
  });

  test("rejects incomplete vector index configs at construction", () => {
    expect(
      () =>
        new OracleStore({
          index: { dims: 2 } as never,
        })
    ).toThrow(
      "OracleStore index embeddings must provide embedDocuments and embedQuery methods."
    );

    expect(
      () =>
        new OracleStore({
          index: {
            dims: 2,
            embeddings: { async embedDocuments() {} },
          } as never,
        })
    ).toThrow(
      "OracleStore index embeddings must provide embedDocuments and embedQuery methods."
    );

    expect(
      () =>
        new OracleStore({
          index: {
            dims: 2,
            embeddings: {
              async embedDocuments() {
                return [];
              },
              async embedQuery() {
                return [];
              },
            },
            fields: ["text", 1],
          } as never,
        })
    ).toThrow("OracleStore index fields must be an array of strings.");
  });

  test("rejects invalid and oversized vector dimensions at construction", () => {
    const embeddings = {
      async embedDocuments() {
        return [];
      },
      async embedQuery() {
        return [];
      },
    };

    for (const dims of [
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      ORACLE_VECTOR_MAX_DIMENSIONS + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(
        () =>
          new OracleStore({
            index: {
              dims,
              embeddings: embeddings as never,
            },
          })
      ).toThrow(
        `OracleStore index dims must be an integer between 1 and ${ORACLE_VECTOR_MAX_DIMENSIONS}`
      );
    }
  });

  test("rejects non-JSON-serializable store values before Oracle writes", async () => {
    const store = new OracleStore({
      pool: unusedPool as never,
      ensureTable: false,
      tableSuffix: "VALIDATION",
    });

    await expect(
      store.put(["bad-values"], "undefined-root", undefined as never)
    ).rejects.toThrow("OracleStore values must be JSON-serializable");

    await expect(
      store.put(["bad-values"], "function-property", {
        kept: true,
        dropped: () => "gone",
      } as never)
    ).rejects.toThrow("contains unsupported function value");

    await expect(
      store.put(["bad-values"], "nan", { score: Number.NaN })
    ).rejects.toThrow("contains a non-finite number");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      store.put(["bad-values"], "circular", circular)
    ).rejects.toThrow("contains circular references");
  });

  test("fails setup when store table is missing but migration is recorded", async () => {
    const prefix = "MISSING_STORE_";
    const connection = new FakeSetupConnection({
      currentVersion: 0,
      existingTables: new Set(),
    });
    const store = new OracleStore({
      pool: fakePool(connection) as never,
      tableSuffix: prefix.replace(/_+$/, ""),
    });

    await expect(
      store.search(["schema-missing"], { limit: 1 })
    ).rejects.toThrow(`STORE_MISSING_STORE is missing`);
    expect(connection.rolledBack).toBe(true);
    expect(connection.committed).toBe(false);
  });

  test("fails setup when vector table is missing but vector migration is recorded", async () => {
    const prefix = "MISSING_VECTOR_";
    const connection = new FakeSetupConnection({
      currentVersion: 4,
      vectorVersion: 0,
      existingTables: new Set(["STORE_MISSING_VECTOR"]),
    });
    const store = new OracleStore({
      pool: fakePool(connection) as never,
      tableSuffix: prefix.replace(/_+$/, ""),
      index: {
        dims: 2,
        embeddings: {
          async embedDocuments() {
            return [];
          },
          async embedQuery() {
            return [0, 0];
          },
        } as never,
      },
    });

    await expect(
      store.search(["schema-missing"], { query: "x" })
    ).rejects.toThrow(`STORE_VECTORS_MISSING_VECTOR is missing`);
    expect(connection.rolledBack).toBe(true);
    expect(connection.committed).toBe(false);
  });

  test("stop resets setup and vector probe state for caller supplied pools", async () => {
    const prefix = "EXTERNAL_POOL_";
    const connection = new FakeSetupConnection({
      currentVersion: 4,
      existingTables: new Set(["STORE_EXTERNAL_POOL"]),
    });
    let closeCalls = 0;
    const pool = {
      async getConnection() {
        return connection;
      },
      async close() {
        closeCalls += 1;
      },
    };
    const store = new OracleStore({
      pool: pool as never,
      tableSuffix: prefix.replace(/_+$/, ""),
    });
    const probe = store as unknown as StoreStateProbe;

    await probe.setup();
    expect(probe.isSetup).toBe(true);
    expect(probe.setupPromise).toBeDefined();

    probe.vectorBindStrategy = "string";
    probe.nativeVectorDmlProbed = true;

    await store.stop();

    expect(closeCalls).toBe(0);
    expect(probe.pool).toBe(pool);
    expect(probe.isSetup).toBe(false);
    expect(probe.setupPromise).toBeUndefined();
    expect(probe.vectorBindStrategy).toBeUndefined();
    expect(probe.nativeVectorDmlProbed).toBe(false);
  });

  test("stop resets setup and vector probe state when owned pool close fails", async () => {
    let closeCalls = 0;
    const pool = {
      async getConnection() {
        throw new Error("should not request a connection");
      },
      async close() {
        closeCalls += 1;
        throw new Error("close failed");
      },
    };
    const store = new OracleStore({
      pool: pool as never,
      tableSuffix: "OWNED_CLOSE_FAIL",
    });
    const probe = store as unknown as StoreStateProbe;
    probe.ownsPool = true;
    probe.isSetup = true;
    probe.setupPromise = Promise.resolve();
    probe.vectorBindStrategy = "native";
    probe.nativeVectorDmlProbed = true;

    await expect(store.stop()).rejects.toThrow("close failed");

    expect(closeCalls).toBe(1);
    expect(probe.pool).toBe(pool);
    expect(probe.isSetup).toBe(false);
    expect(probe.setupPromise).toBeUndefined();
    expect(probe.vectorBindStrategy).toBeUndefined();
    expect(probe.nativeVectorDmlProbed).toBe(false);
  });
});

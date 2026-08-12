import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm exec` runs from the nearest package root, not from this directory, so
// root is pinned to the config's own location. Without it the include glob
// would resolve against libs/checkpoint-oracledb and match nothing.
const here = dirname(fileURLToPath(import.meta.url));

// Standalone from the package suite: these tests only make sense after the
// other language has written its half, so they are never picked up by
// `pnpm test` or `pnpm test:int`.
export default defineConfig({
  root: here,
  test: {
    name: "parity",
    environment: "node",
    globals: true,
    include: ["src/**/*.parity.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One shared schema, ordered phases: never run these in parallel.
    fileParallelism: false,
    maxConcurrency: 1,
  },
});

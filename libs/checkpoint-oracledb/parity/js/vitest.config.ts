import { defineConfig } from "vitest/config";

// Standalone from the package suite: these tests only make sense after the
// other language has written its half, so they are never picked up by
// `pnpm test` or `pnpm test:int`.
export default defineConfig({
  test: {
    name: "parity",
    environment: "node",
    globals: true,
    include: ["src/**/*.parity.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One shared schema, ordered phases: never run these in parallel.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});

import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Files run side by side, but not one per core. Most files in src/api start their own workerd
 * (Miniflare's runtime, through wrangler's getPlatformProxy), and each start is a few hundred
 * megabytes and several seconds of CPU. One per core on a 16-core desk started 16 at once, and
 * under that load workerd dropped connections ("fetch failed") and starts outran their waits, which
 * is where the 30 s timeouts came from. Half the cores, between 2 and 6, keeps the cold starts
 * from piling up and costs little: the suite is bound by those starts, not by the tests.
 * `VEMI_TEST_WORKERS=<n>` overrides it for a machine that knows better. Vitest's own
 * `VITEST_MAX_WORKERS=<n>` is honoured too (an explicit `maxWorkers` here would otherwise shadow it),
 * and VEMI_TEST_WORKERS wins when both are set.
 */
const fromEnv = Number.parseInt(process.env.VEMI_TEST_WORKERS ?? process.env.VITEST_MAX_WORKERS ?? "", 10);
const maxWorkers = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : Math.min(6, Math.max(2, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  resolve: {
    alias: {
      "@vemi/shared": fileURLToPath(new URL("./src/shared/index.ts", import.meta.url)),
      "@vemi/icons": fileURLToPath(new URL("./src/icons/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    maxWorkers,
    // Miniflare starts workerd per file. Its first start on a cold machine is slow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

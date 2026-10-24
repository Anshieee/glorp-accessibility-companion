/*
 * Root Vitest config — owned by the e2e/testing worker (backend owner finished this slot).
 *
 * - Includes ONLY Vitest suites under test/*.test.ts (unit/protocol/e2e).
 * - scripts/demo-evidence.test.mjs runs under Node's native test runner separately and is
 *   NOT a Vitest fixture; repair-evidence.unit.mjs is a standalone script, not a suite.
 * - One browser at a time: maxWorkers=1 + fileParallelism=false (the e2e suite spawns its
 *   own app server + real Chromium; scanner/comparator suites must never overlap that).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["scripts/**", "(node_modules/**|dist/**)"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});

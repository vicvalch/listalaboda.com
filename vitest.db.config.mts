import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Integration tests against the LOCAL Supabase stack (npm run db:test).
// They exercise real RLS as real anon/authenticated users and fail loudly
// if the stack isn't running.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    // Files share the database and its test users; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

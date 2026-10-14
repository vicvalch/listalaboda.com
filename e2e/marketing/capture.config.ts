import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

import base from "../../playwright.config";

/**
 * Marketing screenshot capture (Marketing Landing V1), run on demand with
 * `npm run marketing:capture`, never as part of `npm run test:e2e`.
 *
 * Same local stack and env as the E2E suite, but against `next dev` on its
 * own port: dev compiles only the pages it visits, so a capture never depends
 * on the marketing page (which imports these very images) building first.
 */
const PORT = 3101;
const baseURL = `http://localhost:${PORT}`;
const webServer = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
if (!webServer) throw new Error("The E2E config has no web server to reuse.");

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "capture.spec.ts",
  testIgnore: [],
  globalSetup: "../global-setup.ts",
  outputDir: "../../test-results/marketing-capture",
  use: { ...base.use, baseURL },
  webServer: {
    ...webServer,
    command: `npx next dev --port ${PORT}`,
    // Relative to this file otherwise: the app lives at the repository root.
    cwd: resolve(__dirname, "../.."),
    // Readiness is probed on /login: "/" is the marketing page, which imports
    // the very images this run produces.
    url: `${baseURL}/login`,
    timeout: 600_000,
    env: { ...webServer.env, APP_ORIGIN: baseURL },
  },
});

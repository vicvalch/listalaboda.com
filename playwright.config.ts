import { defineConfig, devices } from "@playwright/test";

import { assertLocal, readLocalSupabase } from "./e2e/support/local-supabase";

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

// The app under test talks to the LOCAL Supabase stack only. Explicit env
// wins (CI may pass it); otherwise it's read from `supabase status`.
function supabaseEnv() {
  const explicitUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const explicitKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (explicitUrl && explicitKey) {
    assertLocal(explicitUrl);
    return { NEXT_PUBLIC_SUPABASE_URL: explicitUrl, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: explicitKey };
  }
  const local = readLocalSupabase();
  return {
    NEXT_PUBLIC_SUPABASE_URL: local.apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.publishableKey,
  };
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Journeys share one local Auth server (and its rate limits); run them
  // one at a time for determinism.
  workers: 1,
  reporter: "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Tests the production build, so headers and rendering match deploys.
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: supabaseEnv(),
  },
});

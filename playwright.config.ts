import { defineConfig, devices } from "@playwright/test";

import { assertLocal, readLocalSupabase } from "./e2e/support/local-supabase";
import { OUTBOX_DIR } from "./e2e/support/outbox";
import { TEST_RSVP_CAPABILITY_KEY_ENV } from "./src/test/fixtures/rsvp-capability-key";

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

// LB-11/LB-12: invitation and RSVP confirmation emails go to a local file outbox the tests read, never
// to a provider. The app only accepts this transport with a localhost origin.
// The delivery recorder (ADR-004) gets the LOCAL stack's secret key, the only
// credential allowed to record a provider-accepted send.
function emailEnv() {
  return {
    APP_ORIGIN: baseURL,
    EMAIL_FROM: "ListaLaBoda Pruebas <invitaciones@example.com>",
    EMAIL_TRANSPORT: "outbox",
    EMAIL_OUTBOX_DIR: OUTBOX_DIR,
    SUPABASE_SERVICE_ROLE_KEY: readLocalSupabase().secretKey,
  };
}

// LB-13: a FAKE, test-only key (its bytes say so) for recoverable RSVP links.
function capabilityEnv() {
  return { RSVP_CAPABILITY_ENCRYPTION_KEY: TEST_RSVP_CAPABILITY_KEY_ENV };
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
    env: { ...supabaseEnv(), ...emailEnv(), ...capabilityEnv() },
  },
});

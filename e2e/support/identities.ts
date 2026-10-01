import { randomUUID } from "node:crypto";

// Fake, local-only identities. Nothing here is a real person or credential.
export const E2E_EMAIL_DOMAIN = "example.test";
export const E2E_EMAIL_PATTERN = `e2e-%@${E2E_EMAIL_DOMAIN}`;

/** Local-only fixture password for fake accounts on the local Supabase stack. */
export const E2E_PASSWORD = "local-only-e2e-password";

const RUN_ID = randomUUID().slice(0, 8);
let counter = 0;

/** A fresh, unique fake address for this run, e.g. e2e-1a2b3c4d-owner-1@example.test. */
export function uniqueEmail(label: string): string {
  counter += 1;
  return `e2e-${RUN_ID}-${label}-${counter}@${E2E_EMAIL_DOMAIN}`;
}

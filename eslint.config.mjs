import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVICE_ROLE_MESSAGE =
  "SUPABASE_SERVICE_ROLE_KEY is exceptional (ADR-002 §6). Read it only inside a dedicated, justified `server-only` module.";

const CAPABILITY_KEY_MESSAGE =
  "RSVP_CAPABILITY_ENCRYPTION_KEY is read only in src/lib/security/rsvp-capability-encryption.ts (ADR-006).";

const CRON_SECRET_MESSAGE =
  "CRON_SECRET is read only in src/lib/scheduler/cron-auth.ts (ADR-010 §4).";

const restrictedEnvKeys = [
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_MESSAGE],
  ["RSVP_CAPABILITY_ENCRYPTION_KEY", CAPABILITY_KEY_MESSAGE],
  ["CRON_SECRET", CRON_SECRET_MESSAGE],
];

/** `process.env.NAME` and `process.env["NAME"]`, except where `allowed` lists the name. */
function envKeyRestrictions(allowed = []) {
  return restrictedEnvKeys
    .filter(([name]) => !allowed.includes(name))
    .flatMap(([name, message]) => [
      {
        selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.name='${name}']`,
        message,
      },
      {
        selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.value='${name}']`,
        message,
      },
    ]);
}

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Keep the service-role key and the RSVP capability encryption key
      // out of application code by default.
      "no-restricted-syntax": ["error", ...envKeyRestrictions()],
    },
  },
  {
    // ADR-004/ADR-005/ADR-007: the first sanctioned service-role use — email
    // delivery metadata (invitation, RSVP confirmation and reminder emails).
    files: ["src/lib/email/delivery-recorder.ts"],
    rules: { "no-restricted-syntax": ["error", ...envKeyRestrictions(["SUPABASE_SERVICE_ROLE_KEY"])] },
  },
  {
    // ADR-010 §21: the automatic RSVP reminder scheduler's store, the second
    // and last sanctioned service-role use. Nowhere else.
    files: ["src/lib/scheduler/rsvp-reminder-store.ts"],
    rules: { "no-restricted-syntax": ["error", ...envKeyRestrictions(["SUPABASE_SERVICE_ROLE_KEY"])] },
  },
  {
    // ADR-010 §4: the one module that reads the scheduler route's secret.
    files: ["src/lib/scheduler/cron-auth.ts"],
    rules: { "no-restricted-syntax": ["error", ...envKeyRestrictions(["CRON_SECRET"])] },
  },
  {
    // ADR-006: the one module that reads the RSVP capability encryption key.
    files: ["src/lib/security/rsvp-capability-encryption.ts"],
    rules: { "no-restricted-syntax": ["error", ...envKeyRestrictions(["RSVP_CAPABILITY_ENCRYPTION_KEY"])] },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVICE_ROLE_MESSAGE =
  "SUPABASE_SERVICE_ROLE_KEY is exceptional (ADR-002 §6). Read it only inside a dedicated, justified `server-only` module.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Keep the service-role key out of application code by default.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='SUPABASE_SERVICE_ROLE_KEY']",
          message: SERVICE_ROLE_MESSAGE,
        },
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.value='SUPABASE_SERVICE_ROLE_KEY']",
          message: SERVICE_ROLE_MESSAGE,
        },
      ],
    },
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

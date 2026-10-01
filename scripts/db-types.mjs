// Generates TypeScript types from the LOCAL Supabase database.
//
//   node scripts/db-types.mjs          write src/lib/supabase/database.types.ts
//   node scripts/db-types.mjs --check  fail if the committed file is stale
//
// The check never writes the committed file. Requires `npx supabase start`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TYPES_FILE = "src/lib/supabase/database.types.ts";
const check = process.argv.includes("--check");

function generate() {
  try {
    return execFileSync(
      "npx",
      ["supabase", "gen", "types", "typescript", "--local", "--schema", "public"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch {
    console.error(
      "Could not generate types from the local database. Is it running? (npm run db:start)",
    );
    process.exit(1);
  }
}

// Line endings vary by platform/git config, and the CLI emits trailing
// whitespace; normalize both so output is deterministic and diff-clean.
const normalize = (text) => text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");

const generated = normalize(generate());

if (!check) {
  writeFileSync(TYPES_FILE, generated);
  console.log(`Wrote ${TYPES_FILE}`);
  process.exit(0);
}

let committed;
try {
  committed = normalize(readFileSync(TYPES_FILE, "utf8"));
} catch {
  console.error(`${TYPES_FILE} is missing. Run: npm run db:types`);
  process.exit(1);
}

if (committed !== generated) {
  console.error(
    `${TYPES_FILE} is stale: it does not match the local database schema.\n` +
      "Run `npm run db:reset && npm run db:types` and commit the result.",
  );
  process.exit(1);
}

console.log(`${TYPES_FILE} matches the local database schema.`);

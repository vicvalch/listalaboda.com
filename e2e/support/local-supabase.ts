import { execFileSync } from "node:child_process";

/**
 * Reads the LOCAL Supabase stack's connection details and refuses anything
 * that isn't localhost, so E2E setup/cleanup can never touch a remote
 * project.
 */
export type LocalSupabase = Readonly<{ apiUrl: string; dbUrl: string; publishableKey: string }>;

let cached: LocalSupabase | null = null;

export function readLocalSupabase(): LocalSupabase {
  if (cached) return cached;

  let status: { API_URL?: string; DB_URL?: string; PUBLISHABLE_KEY?: string };
  try {
    status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "-o", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as typeof status;
  } catch {
    throw new Error(
      "Local Supabase is not running. Start it with `npm run db:start` (requires Docker).",
    );
  }

  const { API_URL, DB_URL, PUBLISHABLE_KEY } = status;
  if (!API_URL || !DB_URL || !PUBLISHABLE_KEY) {
    throw new Error("`supabase status` did not report API_URL, DB_URL and PUBLISHABLE_KEY.");
  }
  assertLocal(API_URL);
  assertLocal(DB_URL);

  cached = { apiUrl: API_URL, dbUrl: DB_URL, publishableKey: PUBLISHABLE_KEY };
  return cached;
}

export function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run E2E against a non-local Supabase host: ${host}`);
  }
}

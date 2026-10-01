/**
 * Public (browser-safe) environment configuration.
 *
 * Only `NEXT_PUBLIC_*` variables may appear here. Next.js inlines them into
 * client bundles, so anything read in this module must be safe to publish.
 * Server-only secrets (e.g. `SUPABASE_SERVICE_ROLE_KEY`) must never be read
 * here — see CLAUDE.md and ADR-002 §6.
 */

export type PublicEnv = Readonly<{
  supabaseUrl: string;
  supabasePublishableKey: string;
}>;

type PublicEnvSource = Readonly<Record<string, string | undefined>>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

function required(source: PublicEnvSource, name: string): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new EnvError(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Decodes the payload of a JWT-shaped key without verifying it. Used only to
 * detect a misconfigured legacy `service_role` key; never for authorization.
 */
function jwtRole(key: string): string | undefined {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload: unknown = JSON.parse(json);
    if (payload && typeof payload === "object" && "role" in payload) {
      const { role } = payload as { role: unknown };
      return typeof role === "string" ? role : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function assertBrowserSafeKey(name: string, key: string): void {
  if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    throw new EnvError(
      `${name} contains a secret/service-role key. Only the publishable (or legacy anon) key may be exposed to the browser.`,
    );
  }
}

/**
 * Validates and narrows a raw env source to the public configuration.
 * Pure: takes the source explicitly so it can be tested without globals.
 */
export function parsePublicEnv(source: PublicEnvSource): PublicEnv {
  const supabaseUrl = required(source, "NEXT_PUBLIC_SUPABASE_URL");
  const supabasePublishableKey = required(
    source,
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  );

  try {
    new URL(supabaseUrl);
  } catch {
    throw new EnvError("NEXT_PUBLIC_SUPABASE_URL must be an absolute URL.");
  }
  assertBrowserSafeKey(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    supabasePublishableKey,
  );

  return Object.freeze({ supabaseUrl, supabasePublishableKey });
}

/**
 * Reads the public configuration from `process.env`.
 *
 * Each variable is referenced literally (`process.env.NEXT_PUBLIC_…`) because
 * that is the only form Next.js inlines into client bundles.
 */
export function getPublicEnv(): PublicEnv {
  return parsePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

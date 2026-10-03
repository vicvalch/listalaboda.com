import { describe, expect, it } from "vitest";

// Vitest resolves `server-only` without the `react-server` condition, exactly
// like a Client Component bundle would, so importing these must throw.
describe("server-only boundary", () => {
  it.each([
    "@/lib/supabase/server",
    "@/lib/membership-invites/token",
    "@/lib/membership-invites/handoff",
    "@/lib/membership-invites/service",
    "@/lib/authz/wedding",
    "@/lib/auth/session",
    "@/lib/http/origin",
    "@/lib/weddings/service",
    "@/lib/checklist/service",
    "@/lib/security/capability-token",
    "@/lib/guests/service",
    "@/lib/rsvp/service",
    "@/lib/rsvp/handoff",
  ])("refuses to load %s outside a server runtime", async (specifier) => {
    await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow(
      /cannot be imported from a Client Component/,
    );
  });
});

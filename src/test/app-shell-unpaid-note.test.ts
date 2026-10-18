import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
const request = vi.hoisted(() => ({ path: "/app" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-lb-request-path": request.path }) }));
const accounts = vi.hoisted(() => ({ requireAppEntry: vi.fn() }));
vi.mock("@/lib/accounts/session", () => accounts);
const server = vi.hoisted(() => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => server);
const runtime = vi.hoisted(() => ({ isBillingAvailable: vi.fn(() => true) }));
vi.mock("@/lib/billing/runtime", () => runtime);

import { getMessages } from "@/lib/i18n";

import { USER_ID, fakeSupabase } from "./fixtures/billing";

const { default: AppLayout } = await import("@/app/app/layout");

// Batch 1: the /app shell tells an account that was NEVER charged that it is
// using ListaLaBoda without paying (no gating), and never says so to anyone
// else, or when it can't be sure.

const { app } = getMessages();

function as(accountType: "planner" | "couple" | null, tables: Parameters<typeof fakeSupabase>[0] = {}) {
  accounts.requireAppEntry.mockResolvedValue({ user: { id: USER_ID, email: "persona@example.test" }, accountType });
  const fake = fakeSupabase(tables);
  server.createSupabaseServerClient.mockResolvedValue(fake.client);
  return fake;
}

async function shell(): Promise<string> {
  const element = await AppLayout({ children: createElement("p", null, "contenido"), params: Promise.resolve({}) } as never);
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  request.path = "/app";
  runtime.isBillingAvailable.mockReturnValue(true);
});

describe("unpaid note in the /app shell", () => {
  it("planner never subscribed: the planner wording and a link to Facturación", async () => {
    as("planner");
    const html = await shell();
    expect(html).toContain('data-testid="unpaid-note"');
    expect(html).toContain(app.unpaidNote.planner);
    expect(html).toContain(`href="/app/billing">${app.unpaidNote.link}<`);
  });

  it("couple never paid: the couple wording, different from the planner's", async () => {
    as("couple");
    const html = await shell();
    expect(html).toContain(app.unpaidNote.couple);
    expect(html).not.toContain(app.unpaidNote.planner);
  });

  it("only reads the user's own billing rows (no Stripe, no writes)", async () => {
    const fake = as("planner");
    await shell();
    expect(fake.reads.map((r) => r.table).sort()).toEqual(["billing_entitlements", "billing_subscriptions"]);
    expect(fake.reads.every((r) => r.filters.some(([c, v]) => c === "user_id" && v === USER_ID))).toBe(true);
  });

  it.each([
    [
      "an active planner",
      "planner",
      {
        billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }],
        billing_subscriptions: [{ user_id: USER_ID, status: "active", current_period_end: null, cancel_at_period_end: false }],
      },
    ],
    [
      "a planner whose subscription ended (was charged before)",
      "planner",
      { billing_subscriptions: [{ user_id: USER_ID, status: "canceled", current_period_end: null, cancel_at_period_end: false }] },
    ],
    [
      "a paid couple",
      "couple",
      {
        billing_entitlements: [{ user_id: USER_ID, entitlement_key: "couple_access", status: "active" }],
        billing_purchases: [{ user_id: USER_ID, status: "paid", purchased_at: "2026-10-16T15:00:00Z" }],
      },
    ],
    ["a couple whose payment is being confirmed", "couple", { billing_purchases: [{ user_id: USER_ID, status: "pending", purchased_at: null }] }],
  ] as const)("hidden for %s", async (_label, accountType, tables) => {
    as(accountType, tables as never);
    expect(await shell()).not.toContain('data-testid="unpaid-note"');
  });

  it("fails open: a failed billing read hides the note (never labels a paying account unpaid)", async () => {
    as("planner", { billing_entitlements: "error" });
    expect(await shell()).not.toContain('data-testid="unpaid-note"');
    as("couple", { billing_purchases: "error" });
    expect(await shell()).not.toContain('data-testid="unpaid-note"');
  });

  it("never on the billing pages, never while billing isn't configured, never for an untyped invited account", async () => {
    request.path = "/app/billing";
    as("planner");
    expect(await shell()).not.toContain('data-testid="unpaid-note"');

    request.path = "/app";
    runtime.isBillingAvailable.mockReturnValue(false);
    const unconfigured = as("planner");
    expect(await shell()).not.toContain('data-testid="unpaid-note"');
    expect(unconfigured.reads).toEqual([]);

    runtime.isBillingAvailable.mockReturnValue(true);
    const untyped = as(null);
    expect(await shell()).not.toContain('data-testid="unpaid-note"');
    expect(untyped.reads).toEqual([]);
  });
});

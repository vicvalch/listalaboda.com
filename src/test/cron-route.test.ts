import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The runner and its runtime are replaced: these tests are about the route's
// boundary (method, secret, configuration, output), never a real scheduler.
const runner = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => vi.fn());
vi.mock("@/lib/scheduler/rsvp-reminder-runner", () => ({ runAutomaticRsvpReminders: runner }));
vi.mock("@/lib/scheduler/runtime", () => ({ getAutomaticReminderRuntime: runtime }));

const route = await import("@/app/api/cron/rsvp-reminders/route");

// LB-17 (ADR-010 §3, §4): GET /api/cron/rsvp-reminders. Fake secret only.

const SECRET = "test-only-cron-secret-0123456789abcdefghij";
const URL_BASE = "http://localhost:3100/api/cron/rsvp-reminders";
const SUMMARY = {
  ok: true,
  claimed: 2,
  sent: 1,
  skipped: 1,
  retry: 0,
  failed: 0,
  unrecorded: 0,
  unknown: 0,
  deferred: 0,
  aborted: false,
};

function get(headers: Record<string, string> = {}, query = "") {
  return route.GET(new NextRequest(`${URL_BASE}${query}`, { method: "GET", headers }));
}

describe("the scheduler route", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    runtime.mockReturnValue({ fake: "runtime" });
    runner.mockResolvedValue(SUMMARY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    runner.mockReset();
    runtime.mockReset();
  });

  it("is dynamic, no-store, 60 s max and GET-only (no other method exported → 405)", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
    const exported = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(exported).toEqual(["GET"]);
  });

  it("GET with the right Bearer secret runs once and answers counts only", async () => {
    const response = await get({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(SUMMARY);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({ fake: "runtime" });
  });

  it("no or wrong secret → 401, empty body, nothing runs (no configuration read)", async () => {
    const attempts: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer wrong-secret-0123456789abcdefghijklmnop" },
      { authorization: SECRET },
    ];
    for (const headers of attempts) {
      const response = await get(headers);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(runtime).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("a secret in the query string is ignored", async () => {
    const response = await get({}, `?secret=${SECRET}&authorization=Bearer%20${SECRET}&token=${SECRET}`);
    expect(response.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it("no CRON_SECRET configured (or too short) → 503 and nothing runs", async () => {
    for (const value of ["", "too-short"]) {
      vi.stubEnv("CRON_SECRET", value);
      const response = await get({ authorization: `Bearer ${value}` });
      expect(response.status).toBe(503);
    }
    expect(runtime).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("missing scheduler configuration → 503, no claim, no email", async () => {
    runtime.mockReturnValue(null);
    const response = await get({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(503);
    expect(runner).not.toHaveBeenCalled();
  });

  it("a failed claim answers 500 with counts only", async () => {
    runner.mockResolvedValue({ ...SUMMARY, ok: false, claimed: 0, sent: 0, skipped: 0 });
    const response = await get({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(500);
    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(SUMMARY).sort());
    expect(Object.values(body).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
  });
});

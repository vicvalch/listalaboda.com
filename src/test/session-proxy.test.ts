import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REQUEST_PATH_HEADER, refreshSession } from "@/lib/supabase/proxy";

// The session-refresh proxy must stay narrow: no redirects, no authorization,
// and its forwarded path header can't be spoofed by the client.

describe("refreshSession (proxy)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes an anonymous request through without redirecting or calling Auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await refreshSession(new NextRequest("http://localhost/app/weddings/new"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("forwards the real request path, overwriting any client-sent value", async () => {
    const request = new NextRequest("http://localhost/app/weddings/new?x=1", {
      headers: { [REQUEST_PATH_HEADER]: "https://evil.example" },
    });
    const response = await refreshSession(request);
    expect(response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe(
      "/app/weddings/new?x=1",
    );
  });
});

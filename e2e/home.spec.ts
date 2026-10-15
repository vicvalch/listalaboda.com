import { expect, test } from "@playwright/test";

import { es } from "./support/flows";

test("/ redirects on the server to the planner page, in Spanish (ACCOUNT-01)", async ({ page, request }) => {
  // A real HTTP redirect (no client JavaScript), temporary while the marketing pages are pre-domain.
  const raw = await request.get("/", { maxRedirects: 0 });
  expect(raw.status()).toBe(307);
  expect(raw.headers()["location"]).toBe("/planners");

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/planners$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(es.marketing.planners.hero.title);
  // Still not indexed (the landing's own policy, unchanged).
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});

test("responses carry the baseline security headers", async ({ request }) => {
  const response = await request.get("/");
  const headers = response.headers();

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["x-powered-by"]).toBeUndefined();
});

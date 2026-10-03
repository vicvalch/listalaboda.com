import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every route.
 *
 * A full Content-Security-Policy (script-src/style-src with per-request
 * nonces) is intentionally deferred to a dedicated prompt: a static CSP
 * either breaks Next.js inline scripts or needs 'unsafe-inline', which would
 * only look like protection. The CSP below sets `frame-ancestors` only.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  // Clickjacking: CSP frame-ancestors for modern browsers, XFO for legacy.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // Ignored by browsers over plain HTTP (localhost). includeSubDomains/preload
  // are left for an explicit decision once the production domain is set up.
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];

/**
 * Guest RSVP routes (LB-09). /rsvp/[token] hands the token off to an
 * httpOnly cookie and redirects, and /rsvp never carries it in the URL;
 * still, nothing on these routes should ever send a Referer. Listed after
 * the global entry: for the same key, the last matching entry wins. Both
 * routes are dynamic and send `no-store` themselves.
 */
const guestRsvpHeaders = [{ key: "Referrer-Policy", value: "no-referrer" }];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/rsvp", headers: guestRsvpHeaders },
      { source: "/rsvp/:path*", headers: guestRsvpHeaders },
    ];
  },
};

export default nextConfig;

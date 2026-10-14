import type { MetadataRoute } from "next";

/**
 * `robots.txt` (Marketing Landing V1, MKT-3). Not a security boundary: every
 * private surface is protected server-side whatever a crawler does.
 *
 * Nothing is indexed yet. The marketing pages and published wedding sites
 * (`/boda/<slug>`) stay crawlable on purpose: their own `noindex, nofollow`
 * is the authority, and a crawler has to fetch a page to read it (a
 * disallowed URL can still be listed from links, without its content). The
 * signed-in app, auth callbacks, membership invites, guest RSVP links and the
 * API are disallowed outright: there's nothing there for a crawler, and an
 * RSVP or invite link is a capability no crawler should ever open.
 *
 * No `Sitemap:` or `Host:` line: both need the production address, and
 * `listalaboda.com` isn't connected yet (never the Vercel deployment's
 * address as the canonical host).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/app", "/auth", "/invite", "/rsvp", "/api"] },
  };
}

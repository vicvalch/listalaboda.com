import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { Notice } from "@/components/ui/Notice";
import { cardClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { parseConfirmationNotice, type ConfirmationNotice } from "@/lib/rsvp/confirmation-notice";
import { GUEST_RSVP_COOKIE, GUEST_RSVP_PAGE_PATH } from "@/lib/rsvp/handoff";
import { getGuestPartyByToken, getGuestPartySiteSlug, type GuestParty } from "@/lib/rsvp/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPublishedWeddingSite } from "@/lib/wedding-site/public";
import type { PublishedWeddingSite } from "@/lib/wedding-site/sections";
import { publicSitePath } from "@/lib/wedding-site/slug";
import { formatWeddingDate } from "@/lib/weddings/format";

import { RsvpForm } from "./RsvpForm";

export const metadata: Metadata = {
  title: getMessages().rsvp.metadataTitle,
  // Token-gated, per-party content: never indexed.
  robots: { index: false, follow: false },
};

// Reads the handoff cookie on every request; never prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * A guest party's RSVP page. No login and no account: the party is resolved
 * from the httpOnly handoff cookie (set by /rsvp/[token]) through the guest
 * token function, which also re-checks that the link is still usable. It
 * shows the party's label and its own guests — no members, checklist or
 * other parties. Wedding details stay private until the couple publishes
 * the wedding website: only then does the page show the same public name,
 * date and city anyone can read at /boda/<slug>, with a link to it. The
 * token says WHICH wedding; publication alone decides whether its fields
 * are shown. Unpublishing never affects the RSVP itself.
 *
 * Every unusable state — no cookie, malformed, unknown, revoked, expired,
 * rotated away, party deleted — renders the same generic page.
 */
export default async function RsvpPage({ searchParams }: PageProps<"/rsvp">) {
  const copy = getMessages().rsvp;
  // Outside any try: reading cookies is what makes this render per-request.
  const token = (await cookies()).get(GUEST_RSVP_COOKIE)?.value ?? "";
  const supabase = await createSupabaseServerClient();
  const result = await getGuestPartyByToken(supabase, token);
  const { saved, email } = await searchParams;

  if (!result.ok) {
    return (
      <Shell>
        {result.reason === "error" ? (
          <Notice tone="error">{getMessages().common.unexpectedError}</Notice>
        ) : (
          <section className="space-y-3 text-center" aria-labelledby="rsvp-unavailable-title">
            <h1 id="rsvp-unavailable-title" className="text-2xl font-semibold tracking-tight">
              {copy.unavailable.title}
            </h1>
            <p className="text-muted">{copy.unavailable.body}</p>
          </section>
        )}
      </Shell>
    );
  }

  const { party } = result;
  const allAnswered = party.guests.every((guest) => guest.attending !== null);
  const siteSlug = await getGuestPartySiteSlug(supabase, token);
  const site = siteSlug ? await getPublishedWeddingSite(supabase, siteSlug) : null;

  return (
    <Shell>
      <section className="space-y-6" aria-labelledby="rsvp-title">
        {site?.ok ? <WeddingContext site={site.site} /> : null}
        <header className="space-y-2">
          <p className="text-muted text-sm font-semibold">{copy.partyLabel}</p>
          <h1 id="rsvp-title" className="text-2xl font-semibold tracking-tight break-words">
            {party.label}
          </h1>
        </header>
        {saved === "1" && allAnswered ? (
          <Saved party={party} notice={parseConfirmationNotice(email)} />
        ) : (
          <>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{copy.title}</h2>
              <p className="text-muted">{copy.intro}</p>
            </div>
            <RsvpForm guests={party.guests} />
          </>
        )}
      </section>
    </Shell>
  );
}

/** Public fields of the published wedding website, never more. */
function WeddingContext({ site }: { site: PublishedWeddingSite }) {
  const copy = getMessages().rsvp;
  const details = [site.weddingDate ? formatWeddingDate(site.weddingDate) : null, site.city].filter(
    (detail): detail is string => detail !== null,
  );
  return (
    <div className="space-y-1 border-b border-border pb-4" data-testid="rsvp-wedding-context">
      <p className="text-muted text-sm font-semibold">{copy.weddingContextLabel}</p>
      <p className="text-lg font-semibold break-words">{site.name}</p>
      {details.length > 0 ? <p className="text-muted break-words">{details.join(" · ")}</p> : null}
      <p className="pt-1">
        <Link href={publicSitePath(site.slug)} className={`${textLinkClass} text-sm`}>
          {copy.viewSite}
        </Link>
      </p>
    </div>
  );
}

/**
 * The RSVP is saved: that is always the headline. The confirmation email
 * (LB-12) only adds a secondary sentence — never the address it went to.
 */
function Saved({ party, notice }: { party: GuestParty; notice: ConfirmationNotice | null }) {
  const copy = getMessages().rsvp;
  return (
    <div className="space-y-4">
      <Notice tone="success">{copy.saved}</Notice>
      {notice ? (
        <p className="text-muted text-sm" data-testid="rsvp-confirmation-note">
          {copy.confirmation[notice]}
        </p>
      ) : null}
      <section aria-labelledby="rsvp-summary-title" className="space-y-2">
        <h2 id="rsvp-summary-title" className="text-lg font-semibold">
          {copy.summaryTitle}
        </h2>
        <ul className="divide-y divide-border" data-testid="rsvp-summary">
          {party.guests.map((guest) => (
            <li key={guest.id} className="py-2" data-testid="rsvp-summary-guest">
              <span className="font-semibold break-words">{guest.name}</span> —{" "}
              {copy.status[guest.attending ? "attending" : "not_attending"]}
            </li>
          ))}
        </ul>
      </section>
      <Link href={GUEST_RSVP_PAGE_PATH} className={`${secondaryButtonClass} w-full sm:w-auto`}>
        {copy.change}
      </Link>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-8 sm:py-14">
      <p className="mb-6 text-xl font-semibold tracking-tight">{getMessages().common.brand}</p>
      <div className={`w-full max-w-lg ${cardClass}`}>{children}</div>
    </main>
  );
}

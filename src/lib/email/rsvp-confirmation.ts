import { es } from "@/lib/i18n/messages/es";
import { interpolate } from "@/lib/i18n";
import { boundedSubject, escapeHtml, type RenderedEmail } from "@/lib/email/invitation";
import { formatWeddingDate } from "@/lib/weddings/format";

/**
 * The RSVP confirmation email (LB-12): subject, plain text and HTML, from a
 * small DTO. Pure — no database, no provider, no env — so every branch is
 * unit-tested. Copy lives in the Spanish catalog (`es.rsvpConfirmationEmail`,
 * answers from `es.rsvp.status`, the wording the guest just saw).
 *
 * It confirms what was SAVED: the DTO is built from the database's own
 * result after the RSVP committed, never from the browser's form.
 *
 * Deliberately NOT in it: the RSVP link or any token (this email's purpose
 * is confirming, not delivering the capability; forwarding it must never
 * hand someone the party's answers), food notes or other free text, the
 * contact email, members, ids or provider data. The public website is
 * linked only while it is published (a locator, not a capability).
 *
 * Everything that came from people (wedding name, party label, guest names,
 * city) is untrusted text: the subject is forced onto one bounded line and
 * the HTML escapes every interpolated value at this boundary.
 */

export type RsvpConfirmationGuest = Readonly<{ name: string; attending: boolean }>;

export type RsvpConfirmationEmailInput = Readonly<{
  partyLabel: string;
  weddingName: string;
  /** Postgres date (`YYYY-MM-DD`) or null. */
  weddingDate: string | null;
  weddingCity: string | null;
  /** The party's CURRENT saved answers, in party order. */
  guests: readonly RsvpConfirmationGuest[];
  /** Absolute public website link, only when the site is published. */
  siteUrl: string | null;
}>;

export function rsvpConfirmationSubject(weddingName: string): string {
  return boundedSubject(es.rsvpConfirmationEmail.subject, weddingName);
}

function answerOf(guest: RsvpConfirmationGuest): string {
  return es.rsvp.status[guest.attending ? "attending" : "not_attending"];
}

type Details = ReadonlyArray<Readonly<{ label: string; value: string }>>;

function detailsOf(input: RsvpConfirmationEmailInput): Details {
  const copy = es.rsvpConfirmationEmail;
  return [
    ...(input.weddingDate ? [{ label: copy.dateLabel, value: formatWeddingDate(input.weddingDate) }] : []),
    ...(input.weddingCity ? [{ label: copy.cityLabel, value: input.weddingCity }] : []),
  ];
}

export function renderRsvpConfirmationText(input: RsvpConfirmationEmailInput): string {
  const copy = es.rsvpConfirmationEmail;
  const values = { party: input.partyLabel, wedding: input.weddingName };
  const lines = [
    interpolate(copy.greeting, values),
    "",
    interpolate(copy.intro, values),
    ...detailsOf(input).map((d) => `${d.label} ${d.value}`),
    "",
    copy.summaryTitle,
    ...input.guests.map((guest) => `- ${guest.name}: ${answerOf(guest)}`),
    "",
    copy.changeNote,
    ...(input.siteUrl ? ["", `${copy.siteIntro} ${input.siteUrl}`] : []),
    "",
    "—",
    interpolate(copy.footer, values),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderRsvpConfirmationHtml(input: RsvpConfirmationEmailInput): string {
  const copy = es.rsvpConfirmationEmail;
  const values = { party: input.partyLabel, wedding: input.weddingName };
  const t = (template: string) => escapeHtml(interpolate(template, values));

  const details = detailsOf(input)
    .map(
      (d) =>
        `<p style="margin:0 0 4px;font-size:16px;line-height:24px;"><strong>${escapeHtml(d.label)}</strong> ${escapeHtml(d.value)}</p>`,
    )
    .join("");

  const guests = input.guests
    .map(
      (guest) =>
        `<tr><td style="padding:8px 0;border-top:1px solid #ece6e1;font-size:16px;line-height:24px;word-break:break-word;"><strong>${escapeHtml(guest.name)}</strong></td><td style="padding:8px 0 8px 16px;border-top:1px solid #ece6e1;font-size:16px;line-height:24px;text-align:right;white-space:nowrap;">${escapeHtml(answerOf(guest))}</td></tr>`,
    )
    .join("");

  const site = input.siteUrl
    ? `<p style="margin:24px 0 0;font-size:15px;line-height:22px;">${escapeHtml(copy.siteIntro)} <a href="${escapeHtml(input.siteUrl)}" style="color:#7a3e48;">${escapeHtml(copy.siteLink)}</a></p>`
    : "";

  return [
    "<!doctype html>",
    '<html lang="es">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(rsvpConfirmationSubject(input.weddingName))}</title></head>`,
    '<body style="margin:0;padding:0;background:#f6f3ef;color:#2b2523;font-family:Arial,Helvetica,sans-serif;">',
    `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(copy.preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ef;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;">',
    '<tr><td style="padding:32px 24px;">',
    `<p style="margin:0 0 8px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#6b605c;">${escapeHtml(copy.eyebrow)}</p>`,
    `<h1 style="margin:0 0 24px;font-size:24px;line-height:32px;font-weight:bold;word-break:break-word;">${escapeHtml(input.weddingName)}</h1>`,
    `<p style="margin:0 0 16px;font-size:16px;line-height:24px;">${t(copy.greeting)}</p>`,
    `<p style="margin:0 0 16px;font-size:16px;line-height:24px;">${t(copy.intro)}</p>`,
    details ? `<div style="margin:0 0 16px;">${details}</div>` : "",
    `<h2 style="margin:24px 0 8px;font-size:18px;line-height:26px;">${escapeHtml(copy.summaryTitle)}</h2>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${guests}</table>`,
    `<p style="margin:24px 0 0;font-size:14px;line-height:20px;color:#6b605c;">${escapeHtml(copy.changeNote)}</p>`,
    site,
    "</td></tr></table>",
    `<p style="margin:16px 0 0;max-width:560px;font-size:12px;line-height:18px;color:#6b605c;">${t(copy.footer)}</p>`,
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

export function renderRsvpConfirmationEmail(input: RsvpConfirmationEmailInput): RenderedEmail {
  return {
    subject: rsvpConfirmationSubject(input.weddingName),
    text: renderRsvpConfirmationText(input),
    html: renderRsvpConfirmationHtml(input),
  };
}

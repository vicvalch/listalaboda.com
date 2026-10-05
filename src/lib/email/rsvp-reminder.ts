import { es } from "@/lib/i18n/messages/es";
import { interpolate } from "@/lib/i18n";
import { boundedSubject, escapeHtml, type RenderedEmail } from "@/lib/email/invitation";
import { formatWeddingDate } from "@/lib/weddings/format";

/**
 * The RSVP reminder email (LB-14, ADR-007): subject, plain text and HTML,
 * from a small DTO. Pure — no database, no provider, no env, no key — so
 * every branch is unit-tested. Copy lives in the Spanish catalog
 * (`es.rsvpReminderEmail`).
 *
 * Unlike the RSVP confirmation (LB-12), a reminder's PURPOSE is to deliver
 * the party's capability again: it carries the party's CURRENT RSVP link,
 * the same link the party already has (recovered by the server, never a
 * new one). The caller builds `rsvpUrl` with `guestRsvpUrl` from the
 * trusted origin.
 *
 * Deliberately NOT in it: the party's answers, food notes or other free
 * text, members, ids, provider data, the token hash or the encrypted
 * envelope. The public website is linked only while it is published.
 *
 * Everything that came from people (wedding name, party label, city) is
 * untrusted text: the subject is forced onto one bounded line and the HTML
 * escapes every interpolated value at this boundary.
 */

export type RsvpReminderEmailInput = Readonly<{
  partyLabel: string;
  weddingName: string;
  /** Postgres date (`YYYY-MM-DD`) or null. */
  weddingDate: string | null;
  weddingCity: string | null;
  /** The party's CURRENT absolute RSVP link, built by the server from the trusted origin. */
  rsvpUrl: string;
  /** Absolute public website link, only when the site is published. */
  siteUrl: string | null;
}>;

export function rsvpReminderSubject(weddingName: string): string {
  return boundedSubject(es.rsvpReminderEmail.subject, weddingName);
}

type Details = ReadonlyArray<Readonly<{ label: string; value: string }>>;

function detailsOf(input: RsvpReminderEmailInput): Details {
  const copy = es.rsvpReminderEmail;
  return [
    ...(input.weddingDate ? [{ label: copy.dateLabel, value: formatWeddingDate(input.weddingDate) }] : []),
    ...(input.weddingCity ? [{ label: copy.cityLabel, value: input.weddingCity }] : []),
  ];
}

export function renderRsvpReminderText(input: RsvpReminderEmailInput): string {
  const copy = es.rsvpReminderEmail;
  const values = { party: input.partyLabel, wedding: input.weddingName };
  const lines = [
    interpolate(copy.greeting, values),
    "",
    interpolate(copy.intro, values),
    ...detailsOf(input).map((d) => `${d.label} ${d.value}`),
    "",
    copy.rsvpIntro,
    "",
    `${copy.cta}: ${input.rsvpUrl}`,
    "",
    copy.personalNote,
    ...(input.siteUrl ? ["", `${copy.siteIntro} ${input.siteUrl}`] : []),
    "",
    copy.thanks,
    "",
    "—",
    interpolate(copy.footer, values),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderRsvpReminderHtml(input: RsvpReminderEmailInput): string {
  const copy = es.rsvpReminderEmail;
  const values = { party: input.partyLabel, wedding: input.weddingName };
  const t = (template: string) => escapeHtml(interpolate(template, values));
  const rsvpHref = escapeHtml(input.rsvpUrl);

  const details = detailsOf(input)
    .map(
      (d) =>
        `<p style="margin:0 0 4px;font-size:16px;line-height:24px;"><strong>${escapeHtml(d.label)}</strong> ${escapeHtml(d.value)}</p>`,
    )
    .join("");

  const site = input.siteUrl
    ? `<p style="margin:24px 0 0;font-size:15px;line-height:22px;">${escapeHtml(copy.siteIntro)} <a href="${escapeHtml(input.siteUrl)}" style="color:#7a3e48;">${escapeHtml(copy.siteLink)}</a></p>`
    : "";

  return [
    "<!doctype html>",
    '<html lang="es">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(rsvpReminderSubject(input.weddingName))}</title></head>`,
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
    `<p style="margin:0 0 24px;font-size:16px;line-height:24px;">${escapeHtml(copy.rsvpIntro)}</p>`,
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>',
    `<td style="border-radius:8px;background:#7a3e48;"><a href="${rsvpHref}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(copy.cta)}</a></td>`,
    "</tr></table>",
    `<p style="margin:24px 0 4px;font-size:14px;line-height:20px;color:#6b605c;">${escapeHtml(copy.fallback)}</p>`,
    `<p style="margin:0;font-size:14px;line-height:20px;word-break:break-all;"><a href="${rsvpHref}" style="color:#7a3e48;">${rsvpHref}</a></p>`,
    `<p style="margin:24px 0 0;font-size:14px;line-height:20px;color:#6b605c;">${escapeHtml(copy.personalNote)}</p>`,
    site,
    `<p style="margin:24px 0 0;font-size:16px;line-height:24px;">${escapeHtml(copy.thanks)}</p>`,
    "</td></tr></table>",
    `<p style="margin:16px 0 0;max-width:560px;font-size:12px;line-height:18px;color:#6b605c;">${t(copy.footer)}</p>`,
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

export function renderRsvpReminderEmail(input: RsvpReminderEmailInput): RenderedEmail {
  return {
    subject: rsvpReminderSubject(input.weddingName),
    text: renderRsvpReminderText(input),
    html: renderRsvpReminderHtml(input),
  };
}

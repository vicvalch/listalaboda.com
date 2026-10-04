import { es } from "@/lib/i18n/messages/es";
import { interpolate } from "@/lib/i18n";
import { formatWeddingDate } from "@/lib/weddings/format";

/**
 * The GuestInvitation email (LB-11): subject, plain text and HTML, from a
 * small DTO. Pure — no database, no provider, no env — so every branch is
 * unit-tested. Copy lives in the Spanish catalog (`es.invitationEmail`),
 * authored for this product (ADR-003: no donor templates).
 *
 * Everything that came from people (wedding name, party label, city) is
 * untrusted text here, even though it passed validation when stored:
 * - the subject is forced onto one line (control characters, CR/LF and
 *   runs of whitespace become single spaces) and bounded;
 * - the HTML escapes every interpolated value, catalog strings included,
 *   at this boundary; links are built by the server, never by users;
 * - the text part is plain text and needs no escaping.
 *
 * Content: the party, the wedding's name, date and city (each only if set),
 * the RSVP call to action with its link, the raw link as a fallback, a note
 * that the link is personal, and the public website only if it is
 * published. Never guests' answers, notes, members, the checklist or ids.
 * No images, tracking pixels or external resources.
 */

export type InvitationEmailInput = Readonly<{
  partyLabel: string;
  weddingName: string;
  /** Postgres date (`YYYY-MM-DD`) or null. */
  weddingDate: string | null;
  weddingCity: string | null;
  /** Absolute RSVP link built by the server from the trusted origin. */
  rsvpUrl: string;
  /** Absolute public website link, only when the site is published. */
  siteUrl: string | null;
}>;

export type RenderedEmail = Readonly<{ subject: string; text: string; html: string }>;

export const SUBJECT_MAX_LENGTH = 200;

/** Collapses anything that could break a header onto one plain line. */
export function toSingleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function invitationSubject(weddingName: string): string {
  const subject = toSingleLine(
    interpolate(es.invitationEmail.subject, { wedding: toSingleLine(weddingName) }),
  );
  return [...subject].length > SUBJECT_MAX_LENGTH
    ? `${[...subject].slice(0, SUBJECT_MAX_LENGTH - 1).join("")}…`
    : subject;
}

type Details = ReadonlyArray<Readonly<{ label: string; value: string }>>;

function detailsOf(input: InvitationEmailInput): Details {
  const copy = es.invitationEmail;
  return [
    ...(input.weddingDate ? [{ label: copy.dateLabel, value: formatWeddingDate(input.weddingDate) }] : []),
    ...(input.weddingCity ? [{ label: copy.cityLabel, value: input.weddingCity }] : []),
  ];
}

export function renderInvitationText(input: InvitationEmailInput): string {
  const copy = es.invitationEmail;
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
    "—",
    interpolate(copy.footer, values),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderInvitationHtml(input: InvitationEmailInput): string {
  const copy = es.invitationEmail;
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
    `<title>${escapeHtml(invitationSubject(input.weddingName))}</title></head>`,
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
    "</td></tr></table>",
    `<p style="margin:16px 0 0;max-width:560px;font-size:12px;line-height:18px;color:#6b605c;">${t(copy.footer)}</p>`,
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  return {
    subject: invitationSubject(input.weddingName),
    text: renderInvitationText(input),
    html: renderInvitationHtml(input),
  };
}

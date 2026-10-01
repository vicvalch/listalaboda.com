import { isPlausibleEmail, normalizeEmail } from "@/lib/auth/validation";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Owner input for a new MembershipInvite. The database re-checks everything
 * (owner role, email normalization, role enum); this gives Spanish errors.
 */

export type InviteRole = Database["public"]["Enums"]["wedding_role"];
export type InviteField = "email" | "role";

export type InviteInput = Readonly<{ email: string | null; role: InviteRole }>;

export type InviteInputResult =
  | Readonly<{ ok: true; input: InviteInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<InviteField, string>> }>;

export const INVITE_ROLES: readonly InviteRole[] = ["collaborator", "owner"];
export const DEFAULT_INVITE_ROLE: InviteRole = "collaborator";

function isInviteRole(value: string): value is InviteRole {
  return (INVITE_ROLES as readonly string[]).includes(value);
}

export function parseInviteInput(raw: { email: string; role: string }): InviteInputResult {
  const messages = es.invites.validation;
  const fieldErrors: Partial<Record<InviteField, string>> = {};

  // Normalized exactly as the database requires: lower(btrim(email)).
  const email = normalizeEmail(raw.email);
  if (email && !isPlausibleEmail(email)) fieldErrors.email = messages.emailInvalid;

  const role = raw.role || DEFAULT_INVITE_ROLE;
  if (!isInviteRole(role)) fieldErrors.role = messages.roleInvalid;

  if (Object.keys(fieldErrors).length > 0 || !isInviteRole(role)) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, input: { email: email || null, role } };
}

"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getRequestOrigin } from "@/lib/http/origin";
import { getMessages } from "@/lib/i18n";
import {
  createMembershipInvite,
  revokeMembershipInvite,
} from "@/lib/membership-invites/service";
import { parseInviteInput, type InviteField } from "@/lib/membership-invites/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { removeWeddingMember, updateMyDisplayName } from "@/lib/weddings/service";
import { parseDisplayName } from "@/lib/weddings/validation";

/**
 * Owner-only invite mutations. The wedding id from the form is only a
 * lookup key: the service re-checks the owner role server-side, and RLS
 * re-checks it in the database.
 */

export type CreateInviteState = FormState<InviteField, { inviteUrl: string }> | null;

export async function createInviteAction(
  _prev: CreateInviteState,
  formData: FormData,
): Promise<CreateInviteState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(`/app/weddings/${encodeURIComponent(weddingId)}`);
  const { common } = getMessages();

  const values = { email: formText(formData, "email").trim(), role: formText(formData, "role") };
  const parsed = parseInviteInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const origin = await getRequestOrigin();
  if (!origin) return { ok: false, formError: common.unexpectedError, values };

  const result = await createMembershipInvite(
    await createSupabaseServerClient(),
    weddingId,
    parsed.input,
    origin,
  );
  if (!result.ok) {
    // Non-members get the same 404 as a nonexistent wedding.
    if (result.reason === "not_found") notFound();
    if (result.reason === "unauthenticated") await requireUser();
    return { ok: false, formError: common.unexpectedError, values };
  }

  revalidatePath(`/app/weddings/${weddingId}`);
  // The one and only time the plaintext link is available.
  return { ok: true, data: { inviteUrl: result.inviteUrl } };
}

export type RevokeInviteState = FormState<never> | null;

export async function revokeInviteAction(
  _prev: RevokeInviteState,
  formData: FormData,
): Promise<RevokeInviteState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(`/app/weddings/${encodeURIComponent(weddingId)}`);

  const result = await revokeMembershipInvite(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "inviteId"),
  );
  revalidatePath(`/app/weddings/${weddingId}`);
  if (!result.ok) return { ok: false, formError: getMessages().invites.revokeFailed };
  return { ok: true, data: undefined };
}

export type DisplayNameState =
  | FormState<"displayName", { message: string; nonce: string }>
  | null;

/**
 * Sets how the current member appears in this wedding. There is no
 * membership id in the form: the service (and the database function) only
 * ever change the caller's own membership. Any member may do it.
 */
export async function updateDisplayNameAction(
  _prev: DisplayNameState,
  formData: FormData,
): Promise<DisplayNameState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(`/app/weddings/${encodeURIComponent(weddingId)}`);
  const copy = getMessages().members.displayName;

  const values = { displayName: formText(formData, "displayName") };
  const parsed = parseDisplayName(values.displayName);
  if (!parsed.ok) return { ok: false, fieldErrors: { displayName: parsed.error }, values };

  const result = await updateMyDisplayName(
    await createSupabaseServerClient(),
    weddingId,
    parsed.displayName,
  );
  if (!result.ok) {
    if (result.reason === "not_found") notFound();
    if (result.reason === "unauthenticated") await requireUser();
    if (result.reason === "invalid") {
      return { ok: false, fieldErrors: { displayName: copy.invalid }, values };
    }
    return { ok: false, formError: copy.failed, values };
  }

  revalidatePath(`/app/weddings/${weddingId}`);
  return { ok: true, data: { message: copy.saved, nonce: crypto.randomUUID() } };
}

export type RemoveMemberState = FormState<never> | null;

/**
 * Owner-only: removes another member from this wedding. The form carries
 * only the wedding id and the target membership id, both lookup keys; the
 * caller, their membership and their role are derived on the server (and
 * re-checked by RLS and the final-owner trigger). The caller's own
 * membership is refused: there is no "leave wedding" flow.
 */
export async function removeMemberAction(
  _prev: RemoveMemberState,
  formData: FormData,
): Promise<RemoveMemberState> {
  const weddingId = formText(formData, "weddingId");
  const weddingPath = `/app/weddings/${encodeURIComponent(weddingId)}`;
  await requireUser(weddingPath);
  const copy = getMessages().members.remove;

  const result = await removeWeddingMember(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "membershipId"),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "unauthenticated":
        await requireUser(weddingPath);
        return { ok: false, formError: copy.failed };
      case "not_found":
        // Non-members get the same 404 as a nonexistent wedding.
        notFound();
      case "invalid_target":
        // Not a member of THIS wedding (any more). Says nothing about any
        // other wedding; the caller already belongs to this one.
        revalidatePath(weddingPath);
        return { ok: false, formError: copy.notFound };
      case "forbidden":
        return { ok: false, formError: copy.forbidden };
      case "cannot_remove_self":
        return { ok: false, formError: copy.cannotRemoveSelf };
      case "last_owner":
        return { ok: false, formError: copy.lastOwner };
      case "error":
        return { ok: false, formError: copy.failed };
    }
  }

  revalidatePath(weddingPath);
  // A fixed flag, no user data: the wedding page shows "removed".
  redirect(`${weddingPath}?removed=member#people-title`);
}

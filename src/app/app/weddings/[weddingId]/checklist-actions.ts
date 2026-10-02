"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import {
  createChecklistItem,
  deleteChecklistItem,
  initializeWeddingChecklist,
  setChecklistItemAssignee,
  setChecklistItemStatus,
  updateChecklistItem,
  type MutationResult,
} from "@/lib/checklist/service";
import type { ChecklistStatus } from "@/lib/checklist/types";
import {
  parseChecklistItemInput,
  parseStatusInput,
  type ChecklistItemField,
  type ChecklistItemRawInput,
} from "@/lib/checklist/validation";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Checklist mutations. Every action re-validates the user; the wedding and
 * item ids from the form are lookup keys only: the service checks
 * membership (owner for initialization) and scopes every query to the
 * authorized wedding, and RLS re-checks it in the database. Non-members get
 * the same 404 as a nonexistent wedding.
 */

function weddingPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}`;
}

async function startAction(formData: FormData): Promise<string> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(weddingPath(weddingId));
  return weddingId;
}

/** Shared failure handling; returns only for failures shown in the form. */
async function handleDenial(result: MutationResult, weddingId: string): Promise<void> {
  if (result.ok) return;
  if (result.reason === "not_found") notFound();
  if (result.reason === "unauthenticated") await requireUser(weddingPath(weddingId));
}

function readItemInput(formData: FormData): ChecklistItemRawInput {
  return {
    title: formText(formData, "title"),
    description: formText(formData, "description"),
    category: formText(formData, "category"),
    timingMode: formText(formData, "timingMode"),
    dueDate: formText(formData, "dueDate"),
    relativeAmount: formText(formData, "relativeAmount"),
    relativeDirection: formText(formData, "relativeDirection"),
  };
}

// -------------------------------------------------------------- initialize

export type InitializeChecklistState = FormState<never> | null;

export async function initializeChecklistAction(
  _prev: InitializeChecklistState,
  formData: FormData,
): Promise<InitializeChecklistState> {
  const weddingId = await startAction(formData);
  const result = await initializeWeddingChecklist(await createSupabaseServerClient(), weddingId);
  revalidatePath(weddingPath(weddingId));
  if (!result.ok) {
    if (result.reason === "not_found") notFound();
    if (result.reason === "unauthenticated") await requireUser(weddingPath(weddingId));
    return { ok: false, formError: getMessages().checklist.init.failed };
  }
  // Already initialized (e.g. a double submit) is fine: the page shows the list.
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------- create / edit

export type ChecklistItemFormState =
  | FormState<ChecklistItemField, { message: string; nonce: string }>
  | null;

export async function createChecklistItemAction(
  _prev: ChecklistItemFormState,
  formData: FormData,
): Promise<ChecklistItemFormState> {
  const weddingId = await startAction(formData);
  const { checklist } = getMessages();
  const values = readItemInput(formData);
  const parsed = parseChecklistItemInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const result = await createChecklistItem(
    await createSupabaseServerClient(),
    weddingId,
    parsed.input,
  );
  await handleDenial(result, weddingId);
  if (!result.ok) return { ok: false, formError: checklist.errors.saveFailed, values };

  revalidatePath(weddingPath(weddingId));
  return {
    ok: true,
    data: { message: checklist.announcements.created, nonce: crypto.randomUUID() },
  };
}

export async function updateChecklistItemAction(
  _prev: ChecklistItemFormState,
  formData: FormData,
): Promise<ChecklistItemFormState> {
  const weddingId = await startAction(formData);
  const { checklist } = getMessages();
  const values = readItemInput(formData);
  const parsed = parseChecklistItemInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const result = await updateChecklistItem(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "itemId"),
    parsed.input,
  );
  await handleDenial(result, weddingId);
  revalidatePath(weddingPath(weddingId));
  if (!result.ok) return { ok: false, formError: checklist.errors.saveFailed, values };
  return {
    ok: true,
    data: { message: checklist.announcements.saved, nonce: crypto.randomUUID() },
  };
}

// ------------------------------------------------------------------ status

export type StatusChangeState = FormState<never, { status: ChecklistStatus }> | null;

export async function setChecklistItemStatusAction(
  _prev: StatusChangeState,
  formData: FormData,
): Promise<StatusChangeState> {
  const weddingId = await startAction(formData);
  const { checklist } = getMessages();
  const status = parseStatusInput(formText(formData, "status"));
  if (!status) return { ok: false, formError: checklist.errors.saveFailed };

  const result = await setChecklistItemStatus(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "itemId"),
    status,
  );
  await handleDenial(result, weddingId);
  revalidatePath(weddingPath(weddingId));
  if (!result.ok) return { ok: false, formError: checklist.errors.saveFailed };
  return { ok: true, data: { status } };
}

// -------------------------------------------------------------- assignment

export type AssignmentState = FormState<never, { nonce: string }> | null;

/**
 * Assigns, reassigns or unassigns an item. The submitted membership id is
 * only the requested target ("" = Sin asignar): the service checks the
 * caller's membership, and the database accepts only a membership of the
 * item's own wedding. Status, timing and order are never touched.
 */
export async function setChecklistItemAssigneeAction(
  _prev: AssignmentState,
  formData: FormData,
): Promise<AssignmentState> {
  const weddingId = await startAction(formData);
  const { assignment } = getMessages().checklist;
  const assignee = formText(formData, "assigneeMembershipId").trim();

  const result = await setChecklistItemAssignee(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "itemId"),
    assignee === "" ? null : assignee,
  );
  await handleDenial(result, weddingId);
  revalidatePath(weddingPath(weddingId));
  if (!result.ok) {
    return {
      ok: false,
      formError: result.reason === "invalid_assignee" ? assignment.invalidMember : assignment.failed,
    };
  }
  return { ok: true, data: { nonce: crypto.randomUUID() } };
}

// ------------------------------------------------------------------ delete

export type DeleteItemState = FormState<never> | null;

export async function deleteChecklistItemAction(
  _prev: DeleteItemState,
  formData: FormData,
): Promise<DeleteItemState> {
  const weddingId = await startAction(formData);
  const result = await deleteChecklistItem(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "itemId"),
  );
  await handleDenial(result, weddingId);
  revalidatePath(weddingPath(weddingId));
  // Already gone (a partner deleted it first) is what the user wanted.
  if (!result.ok && result.reason !== "item_not_found") {
    return { ok: false, formError: getMessages().checklist.errors.deleteFailed };
  }
  return { ok: true, data: undefined };
}

"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import {
  createSeatingTable,
  deleteSeatingTable,
  moveGuest,
  seatGuest,
  unseatGuest,
  updateSeatingTable,
  type SeatingFailureReason,
} from "@/lib/seating/service";
import { parseTableInput, type TableField } from "@/lib/seating/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Seating plan mutations (LB-19): tables, seat, move, unseat. Any member of
 * the wedding (owner or collaborator). Forms carry only lookup keys (wedding,
 * table, guest ids) and the typed name/capacity; the caller and their
 * membership are derived on the server by the service, and the database
 * re-checks every write (same-wedding FKs, capacity under a row lock,
 * declined guests). Results carry only catalog messages, never database
 * errors. Only the seating page is revalidated: nothing else shows seating.
 */

function seatingPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/seating`;
}

/** Maps a service failure to a form message (or a 404 / login redirect). */
async function failureMessage(weddingId: string, reason: SeatingFailureReason): Promise<string> {
  const copy = getMessages().seating.errors;
  switch (reason) {
    case "unauthenticated":
      await requireUser(seatingPath(weddingId));
      return copy.failed;
    case "not_found":
      // Non-members get the same 404 as a nonexistent wedding.
      notFound();
    case "invalid_target":
      revalidatePath(seatingPath(weddingId));
      return copy.notFound;
    case "table_full":
      revalidatePath(seatingPath(weddingId));
      return copy.tableFull;
    case "capacity_below_assigned":
      return copy.capacityBelowAssigned;
    case "guest_declined":
      revalidatePath(seatingPath(weddingId));
      return copy.guestDeclined;
    case "already_seated":
      revalidatePath(seatingPath(weddingId));
      return copy.alreadySeated;
    case "invalid_input":
      return copy.invalid;
    case "forbidden":
    case "database_error":
      return copy.failed;
  }
}

// ------------------------------------------------------------------ tables

export type TableFormState = FormState<TableField, { message: string; nonce: string }> | null;

async function saveTable(formData: FormData, tableId: string | null): Promise<TableFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(seatingPath(weddingId));
  const copy = getMessages().seating;

  const values = { name: formText(formData, "name"), capacity: formText(formData, "capacity") };
  const parsed = parseTableInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const supabase = await createSupabaseServerClient();
  const result = tableId
    ? await updateSeatingTable(supabase, weddingId, tableId, parsed.input)
    : await createSeatingTable(supabase, weddingId, parsed.input);
  if (!result.ok) {
    if (result.reason === "capacity_below_assigned") {
      return { ok: false, fieldErrors: { capacity: copy.errors.capacityBelowAssigned }, values };
    }
    return { ok: false, formError: await failureMessage(weddingId, result.reason), values };
  }

  revalidatePath(seatingPath(weddingId));
  return {
    ok: true,
    data: { message: tableId ? copy.editTable.saved : copy.newTable.created, nonce: crypto.randomUUID() },
  };
}

export async function createTableAction(_prev: TableFormState, formData: FormData): Promise<TableFormState> {
  return saveTable(formData, null);
}

export async function updateTableAction(_prev: TableFormState, formData: FormData): Promise<TableFormState> {
  return saveTable(formData, formText(formData, "tableId"));
}

/** Same shape as the guest list's confirmation state, so the shared ConfirmButton fits. */
export type ConfirmState = FormState<never> | null;

export async function deleteTableAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(seatingPath(weddingId));

  const result = await deleteSeatingTable(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "tableId"),
  );
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason) };
  revalidatePath(seatingPath(weddingId));
  return { ok: true, data: undefined };
}

// ------------------------------------------------------------- assignments

export type SeatingActionState = FormState<never, { nonce: string }> | null;

async function runAssignment(
  formData: FormData,
  run: (weddingId: string, guestId: string, tableId: string) => Promise<{ ok: true } | { ok: false; reason: SeatingFailureReason }>,
  needsTable: boolean,
): Promise<SeatingActionState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(seatingPath(weddingId));

  const tableId = formText(formData, "tableId");
  if (needsTable && !tableId) return { ok: false, formError: getMessages().seating.errors.chooseTable };

  const result = await run(weddingId, formText(formData, "guestId"), tableId);
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason) };
  revalidatePath(seatingPath(weddingId));
  return { ok: true, data: { nonce: crypto.randomUUID() } };
}

export async function seatGuestAction(_prev: SeatingActionState, formData: FormData): Promise<SeatingActionState> {
  return runAssignment(
    formData,
    async (weddingId, guestId, tableId) =>
      seatGuest(await createSupabaseServerClient(), weddingId, guestId, tableId),
    true,
  );
}

export async function moveGuestAction(_prev: SeatingActionState, formData: FormData): Promise<SeatingActionState> {
  return runAssignment(
    formData,
    async (weddingId, guestId, tableId) =>
      moveGuest(await createSupabaseServerClient(), weddingId, guestId, tableId),
    true,
  );
}

export async function unseatGuestAction(_prev: SeatingActionState, formData: FormData): Promise<SeatingActionState> {
  return runAssignment(
    formData,
    async (weddingId, guestId) => unseatGuest(await createSupabaseServerClient(), weddingId, guestId),
    false,
  );
}

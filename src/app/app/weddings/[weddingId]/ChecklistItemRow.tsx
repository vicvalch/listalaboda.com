"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { guestPartyHref, type GuestPartyOption } from "@/lib/checklist/guest-work";
import { statusControls } from "@/lib/checklist/presentation";
import type { ChecklistItem } from "@/lib/checklist/types";
import { itemFormValues } from "@/lib/checklist/validation";
import { getMessages } from "@/lib/i18n";
import type { MemberOption } from "@/lib/weddings/members";

import { ChecklistItemFields } from "./ChecklistItemFields";
import {
  deleteChecklistItemAction,
  setChecklistItemAssigneeAction,
  setChecklistItemGuestPartyAction,
  setChecklistItemStatusAction,
  updateChecklistItemAction,
  type AssignmentState,
  type ChecklistItemFormState,
  type DeleteItemState,
  type GuestWorkState,
  type StatusChangeState,
} from "./checklist-actions";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

const statusBadgeClass = {
  pending: "border border-border",
  done: "bg-success-soft text-success",
  not_applicable: "bg-border/60 text-muted",
} as const;

/**
 * Accessible name for a repeated per-item control: the visible label first
 * (so voice control matches what's on screen), then which item it acts on.
 */
function withTitle(label: string, title: string): string {
  return `${label}: ${title}`;
}

type Props = {
  weddingId: string;
  item: ChecklistItem;
  /**
   * Derived on the server for this request (pending, dated, before the
   * wedding-local today). A marker only: the status stays "Pendiente".
   */
  overdue: boolean;
  /** Server-formatted timing line (dates are formatted once, on the server). */
  timingText: string | null;
  /**
   * Who is responsible ("Tú", a name, "Sin asignar") and who it can be
   * assigned to (current members of this wedding). null when the members
   * couldn't be loaded: the assignment is then not shown at all.
   */
  assignment: Readonly<{ label: string; options: readonly MemberOption[] }> | null;
  /**
   * LB-16: the guest party this item is about (its CURRENT label, or null
   * when unlinked or the party is gone) and the wedding's parties to choose
   * from (id + label only). null when the parties couldn't be loaded: the
   * relation is then not shown at all.
   */
  guestWork: Readonly<{ linked: GuestPartyOption | null; options: readonly GuestPartyOption[] }> | null;
};

/**
 * One checklist item. The done checkbox toggles pending ⇄ done; "No aplica"
 * and "Volver a pendiente" are explicit buttons, so status never depends on
 * the checkbox (or on color) alone. Each status change is announced.
 */
export function ChecklistItemRow({
  weddingId,
  item,
  overdue,
  timingText,
  assignment,
  guestWork,
}: Props) {
  const [statusState, statusAction, statusPending] = useActionState<StatusChangeState, FormData>(
    setChecklistItemStatusAction,
    null,
  );
  const { checklist } = getMessages();
  const controls = statusControls(item.status);
  const titleId = `item-${item.id}-title`;
  const isDone = item.status === "done";

  const hiddenFields = (status: string) => (
    <>
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="status" value={status} />
    </>
  );

  return (
    <li
      id={`item-${item.id}`}
      data-testid="checklist-item"
      data-status={item.status}
      data-overdue={overdue ? "true" : undefined}
      className="rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex items-start gap-3">
        {controls.toggle ? (
          <form action={statusAction} className="shrink-0">
            {hiddenFields(controls.toggle.target)}
            <button
              type="submit"
              role="checkbox"
              aria-checked={isDone}
              aria-labelledby={titleId}
              title={controls.toggle.label}
              disabled={statusPending}
              className={`flex size-11 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-60 ${
                isDone
                  ? "border-success bg-success text-surface"
                  : "border-border hover:border-accent"
              }`}
            >
              {isDone ? (
                <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="currentColor">
                  <path d="M7.7 13.3 4.4 10l-1.2 1.2 4.5 4.5 9.1-9.1-1.2-1.2z" />
                </svg>
              ) : null}
            </button>
          </form>
        ) : (
          <span
            aria-hidden="true"
            className="text-muted flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-border"
          >
            –
          </span>
        )}

        <div className="min-w-0 flex-1 space-y-1.5">
          <p
            id={titleId}
            className={`pt-2 font-semibold break-words ${isDone ? "text-muted line-through decoration-2" : ""}`}
          >
            {item.title}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadgeClass[item.status]}`}
              data-testid="checklist-item-status"
            >
              {checklist.status[item.status]}
            </span>
            {/* Text, not just color: "Pendiente · Atrasado". */}
            {overdue ? (
              <span
                className="rounded-full border border-danger px-2 py-0.5 text-xs font-semibold text-danger"
                data-testid="checklist-item-overdue"
              >
                {checklist.overdue.badge}
              </span>
            ) : null}
            {item.category ? (
              <span className="text-muted">{checklist.categories[item.category]}</span>
            ) : null}
            {assignment ? (
              <span data-testid="checklist-item-assignee">
                <span className="text-muted">{checklist.assignment.label}: </span>
                <span className={item.assigneeMembershipId ? "font-semibold" : "text-muted"}>
                  {assignment.label}
                </span>
              </span>
            ) : null}
          </p>
          {timingText ? (
            <p className="text-sm" data-testid="checklist-item-timing">
              {timingText}
            </p>
          ) : null}
          {guestWork?.linked ? (
            <p className="text-sm break-words" data-testid="checklist-item-guest-work">
              <span className="text-muted">{checklist.guestWork.label}: </span>
              <span className="font-semibold">{guestWork.linked.label}</span>
              {" · "}
              <Link
                href={guestPartyHref(weddingId, guestWork.linked.id)}
                aria-label={withTitle(checklist.guestWork.viewParty, guestWork.linked.label)}
                className={textLinkClass}
              >
                {checklist.guestWork.viewParty}
              </Link>
            </p>
          ) : null}
          {item.description ? (
            <p className="text-muted text-sm whitespace-pre-line break-words">{item.description}</p>
          ) : null}

          {controls.secondary.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {controls.secondary.map((action) => (
                <form key={action.target} action={statusAction}>
                  {hiddenFields(action.target)}
                  <button
                    type="submit"
                    disabled={statusPending}
                    aria-label={withTitle(action.label, item.title)}
                    className={smallButtonClass}
                  >
                    {action.label}
                  </button>
                </form>
              ))}
            </div>
          ) : null}

          <p role="status" className="text-success text-sm font-medium">
            {statusState?.ok ? checklist.announcements[statusState.data.status] : null}
          </p>
          {statusState && !statusState.ok ? (
            <p role="alert" className="text-danger text-sm">
              {statusState.formError}
            </p>
          ) : null}

          {assignment ? (
            <details className="pt-1">
              <summary
                aria-label={withTitle(checklist.assignment.open, item.title)}
                className="text-accent inline-flex min-h-9 cursor-pointer items-center text-sm font-semibold underline-offset-4 hover:underline"
              >
                {checklist.assignment.open}
              </summary>
              <AssignChecklistItem weddingId={weddingId} item={item} options={assignment.options} />
            </details>
          ) : null}

          {guestWork ? (
            <details className="pt-1">
              <summary
                aria-label={withTitle(
                  guestWork.linked ? checklist.guestWork.change : checklist.guestWork.open,
                  item.title,
                )}
                className="text-accent inline-flex min-h-9 cursor-pointer items-center text-sm font-semibold underline-offset-4 hover:underline"
              >
                {guestWork.linked ? checklist.guestWork.change : checklist.guestWork.open}
              </summary>
              <LinkGuestParty
                weddingId={weddingId}
                item={item}
                linked={guestWork.linked}
                options={guestWork.options}
              />
            </details>
          ) : null}

          <details className="group pt-1">
            <summary
              aria-label={withTitle(checklist.actions.edit, item.title)}
              className="text-accent inline-flex min-h-9 cursor-pointer items-center text-sm font-semibold underline-offset-4 hover:underline"
            >
              {checklist.actions.edit}
            </summary>
            <div className="mt-3 space-y-5 border-t border-border pt-4">
              <EditChecklistItem weddingId={weddingId} item={item} />
              <DeleteChecklistItem weddingId={weddingId} itemId={item.id} itemTitle={item.title} />
            </div>
          </details>
        </div>
      </div>
    </li>
  );
}

/**
 * "Asignar a": a native select (keyboard and mobile friendly) and an
 * explicit save, so nothing changes just by moving through the options.
 * No confirmation: assignment is ordinary, reversible planning.
 */
function AssignChecklistItem({
  weddingId,
  item,
  options,
}: {
  weddingId: string;
  item: ChecklistItem;
  options: readonly MemberOption[];
}) {
  const [state, formAction] = useActionState<AssignmentState, FormData>(
    setChecklistItemAssigneeAction,
    null,
  );
  const { assignment: copy } = getMessages().checklist;
  const selectId = `assign-${item.id}`;
  const errorId = `assign-${item.id}-error`;
  const failure = state && !state.ok ? state : null;

  return (
    <div className="mt-2 space-y-2">
      {/* Remount when the saved assignee changes, so the select shows it. */}
      <form
        key={`${item.assigneeMembershipId ?? "none"}-${state?.ok ? state.data.nonce : ""}`}
        action={formAction}
        className="flex flex-wrap items-end gap-2"
      >
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="itemId" value={item.id} />
        <div className="min-w-0 flex-1 space-y-1 sm:max-w-64">
          <label htmlFor={selectId} className="block text-sm font-semibold">
            {copy.selectLabel}
          </label>
          <select
            id={selectId}
            name="assigneeMembershipId"
            defaultValue={item.assigneeMembershipId ?? ""}
            aria-invalid={failure ? true : undefined}
            aria-describedby={failure ? errorId : undefined}
            className={`${inputClass} min-h-9 py-1.5`}
          >
            <option value="">{copy.unassigned}</option>
            {options.map((option) => (
              <option key={option.membershipId} value={option.membershipId}>
                {option.optionLabel}
              </option>
            ))}
          </select>
        </div>
        <SubmitButton
          label={copy.submit}
          pendingLabel={copy.submitting}
          variant="secondary"
          className="min-h-9 px-3 py-1.5"
        />
      </form>
      <p role="status" className="text-success text-sm font-medium">
        {state?.ok ? copy.saved : null}
      </p>
      {failure ? (
        <p id={errorId} role="alert" className="text-danger text-sm">
          {failure.formError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Vincular con invitados" / "Cambiar vínculo": a native select of the
 * wedding's parties (labels only) with an explicit save, and "Quitar
 * vínculo" when linked. Only the party id is submitted; nothing about the
 * party is shown or sent beyond its current label. A shortcut, not a
 * workflow: it never changes the item's status.
 */
function LinkGuestParty({
  weddingId,
  item,
  linked,
  options,
}: {
  weddingId: string;
  item: ChecklistItem;
  linked: GuestPartyOption | null;
  options: readonly GuestPartyOption[];
}) {
  const [state, formAction] = useActionState<GuestWorkState, FormData>(
    setChecklistItemGuestPartyAction,
    null,
  );
  const [removeState, removeAction] = useActionState<GuestWorkState, FormData>(
    setChecklistItemGuestPartyAction,
    null,
  );
  const { guestWork: copy } = getMessages().checklist;
  const selectId = `guest-work-${item.id}`;
  const errorId = `guest-work-${item.id}-error`;
  const failure = state && !state.ok ? state : removeState && !removeState.ok ? removeState : null;

  if (options.length === 0 && !linked) {
    return (
      <p className="text-muted mt-2 text-sm">
        {copy.noParties}{" "}
        <Link href={`/app/weddings/${encodeURIComponent(weddingId)}/guests`} className={textLinkClass}>
          {copy.goToGuests}
        </Link>
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <p className="text-muted text-sm">{copy.hint}</p>
      {/* Remount when the saved party changes, so the select shows it. */}
      <form
        key={`${linked?.id ?? "none"}-${state?.ok ? state.data.nonce : ""}`}
        action={formAction}
        className="flex flex-wrap items-end gap-2"
      >
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="itemId" value={item.id} />
        <div className="min-w-0 flex-1 space-y-1 sm:max-w-64">
          <label htmlFor={selectId} className="block text-sm font-semibold">
            {copy.selectLabel}
          </label>
          <select
            id={selectId}
            name="guestInvitationId"
            required
            defaultValue={linked?.id ?? ""}
            aria-invalid={failure ? true : undefined}
            aria-describedby={failure ? errorId : undefined}
            className={`${inputClass} min-h-9 py-1.5`}
          >
            <option value="">{copy.choose}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <SubmitButton
          label={copy.submit}
          pendingLabel={copy.submitting}
          variant="secondary"
          className="min-h-9 px-3 py-1.5"
        />
      </form>
      {linked ? (
        <form action={removeAction}>
          <input type="hidden" name="weddingId" value={weddingId} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="guestInvitationId" value="" />
          <SubmitButton
            label={copy.remove}
            pendingLabel={copy.removing}
            variant="secondary"
            className="min-h-9 px-3 py-1.5"
          />
        </form>
      ) : null}
      <p role="status" className="text-success text-sm font-medium">
        {state?.ok && linked ? copy.saved : null}
      </p>
      {failure ? (
        <p id={errorId} role="alert" className="text-danger text-sm">
          {failure.formError}
        </p>
      ) : null}
    </div>
  );
}

function EditChecklistItem({ weddingId, item }: { weddingId: string; item: ChecklistItem }) {
  const [state, formAction] = useActionState<ChecklistItemFormState, FormData>(
    updateChecklistItemAction,
    null,
  );
  const { checklist } = getMessages();
  const failure = state && !state.ok ? state : null;
  const defaults = { ...itemFormValues(item), ...failure?.values };

  return (
    <div className="space-y-3">
      {/* Remount after a successful save so the fields show the saved values. */}
      <form
        key={state?.ok ? state.data.nonce : "edit"}
        action={formAction}
        className="space-y-4"
        noValidate
      >
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="itemId" value={item.id} />
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <ChecklistItemFields
          idPrefix={`edit-${item.id}`}
          defaults={defaults}
          fieldErrors={failure?.fieldErrors}
          withDescription
        />
        <SubmitButton
          label={checklist.form.submitEdit}
          pendingLabel={checklist.form.submittingEdit}
        />
      </form>
      <p role="status" className="text-success text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );
}

/** Two-step delete: "Eliminar", then an explicit confirmation. */
function DeleteChecklistItem({
  weddingId,
  itemId,
  itemTitle,
}: {
  weddingId: string;
  itemId: string;
  itemTitle: string;
}) {
  const [state, formAction] = useActionState<DeleteItemState, FormData>(
    deleteChecklistItemAction,
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const { checklist } = getMessages();
  const copy = checklist.delete;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={withTitle(copy.open, itemTitle)}
        className={`${smallButtonClass} text-danger`}
      >
        {copy.open}
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-lg border border-danger/40 bg-danger-soft p-3"
    >
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="itemId" value={itemId} />
      <p id={`delete-${itemId}-confirm`} className="text-sm font-semibold">
        {copy.confirm}
      </p>
      {state && !state.ok ? (
        <p role="alert" className="text-danger text-sm">
          {state.formError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          ref={confirmRef}
          type="submit"
          aria-describedby={`delete-${itemId}-confirm`}
          className={`${smallButtonClass} border-danger text-danger`}
        >
          {copy.confirmButton}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className={smallButtonClass}>
          {copy.cancel}
        </button>
      </div>
    </form>
  );
}

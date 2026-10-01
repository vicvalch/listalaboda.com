"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { secondaryButtonClass } from "@/components/ui/styles";
import { statusControls } from "@/lib/checklist/presentation";
import type { ChecklistItem } from "@/lib/checklist/types";
import { itemFormValues } from "@/lib/checklist/validation";
import { getMessages } from "@/lib/i18n";

import { ChecklistItemFields } from "./ChecklistItemFields";
import {
  deleteChecklistItemAction,
  setChecklistItemStatusAction,
  updateChecklistItemAction,
  type ChecklistItemFormState,
  type DeleteItemState,
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
  /** Server-formatted timing line (dates are formatted once, on the server). */
  timingText: string | null;
};

/**
 * One checklist item. The done checkbox toggles pending ⇄ done; "No aplica"
 * and "Volver a pendiente" are explicit buttons, so status never depends on
 * the checkbox (or on color) alone. Each status change is announced.
 */
export function ChecklistItemRow({ weddingId, item, timingText }: Props) {
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
            {item.category ? (
              <span className="text-muted">{checklist.categories[item.category]}</span>
            ) : null}
          </p>
          {timingText ? (
            <p className="text-sm" data-testid="checklist-item-timing">
              {timingText}
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

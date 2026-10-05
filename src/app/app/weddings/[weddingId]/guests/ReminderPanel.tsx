"use client";

import { useActionState, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";

import {
  prepareReminderMessageAction,
  sendReminderAction,
  type ReminderMessageState,
  type SendReminderState,
} from "./actions";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

type Props = {
  weddingId: string;
  /** Lookup key only. */
  guestInvitationId: string;
  partyLabel: string;
  /**
   * Shown in the hint only. Never sent back: the server reads the party's
   * CURRENT contact email when the button is pressed.
   */
  contactEmail: string | null;
  /** Owner: may generate a new link. Cosmetic; the server re-checks. */
  canAdministerLink: boolean;
};

/**
 * "Recordatorio de confirmación" (LB-14, ADR-007): two explicit, manual
 * channels, both with the party's CURRENT link, recovered on the server at
 * the moment of the action (never on page load, never a new link).
 *
 * - "Enviar recordatorio": one email to the party's contact email.
 * - "Preparar mensaje para WhatsApp": text to copy and send yourself. It
 *   is never sent or recorded by the app; the text lives only in this
 *   component's state (never storage, cookies or a URL) until "Ocultar".
 */
export function ReminderPanel({ weddingId, guestInvitationId, partyLabel, contactEmail, canAdministerLink }: Props) {
  const copy = getMessages().guests.reminder;
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="party-reminder">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{copy.title}</p>
        <p className="text-muted text-sm">{copy.hint}</p>
      </div>
      {contactEmail ? (
        <SendReminderForm
          weddingId={weddingId}
          guestInvitationId={guestInvitationId}
          contactEmail={contactEmail}
          canAdministerLink={canAdministerLink}
        />
      ) : (
        <p className="text-muted text-sm" data-testid="reminder-no-email">
          {copy.noEmail}
        </p>
      )}
      <WhatsAppReminder
        weddingId={weddingId}
        guestInvitationId={guestInvitationId}
        partyLabel={partyLabel}
        canAdministerLink={canAdministerLink}
      />
    </div>
  );
}

function SendReminderForm({
  weddingId,
  guestInvitationId,
  contactEmail,
  canAdministerLink,
}: {
  weddingId: string;
  guestInvitationId: string;
  contactEmail: string;
  canAdministerLink: boolean;
}) {
  const [state, formAction] = useActionState<SendReminderState, FormData>(sendReminderAction, null);
  const copy = getMessages().guests.reminder;
  const personal = getMessages().guests.personalLink;
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="guestInvitationId" value={guestInvitationId} />
      <p className="text-muted text-sm break-words">{interpolate(copy.sendHint, { email: contactEmail })}</p>
      <SubmitButton label={copy.send} pendingLabel={copy.sending} variant="secondary" />
      {state ? (
        <div key={state.nonce} data-testid="reminder-email-result">
          <Notice tone={state.tone}>
            {state.message}
            {state.needsNewLink
              ? ` ${canAdministerLink ? personal.regenerateOwner : personal.regenerateCollaborator}`
              : null}
          </Notice>
        </div>
      ) : null}
    </form>
  );
}

type CopyState = "idle" | "copied" | "failed";

function WhatsAppReminder({
  weddingId,
  guestInvitationId,
  partyLabel,
  canAdministerLink,
}: {
  weddingId: string;
  guestInvitationId: string;
  partyLabel: string;
  canAdministerLink: boolean;
}) {
  const [state, formAction] = useActionState<ReminderMessageState, FormData>(prepareReminderMessageAction, null);
  const [hiddenNonce, setHiddenNonce] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ nonce: string; state: CopyState } | null>(null);
  const copy = getMessages().guests.reminder;
  const personal = getMessages().guests.personalLink;
  const visible = state && state.nonce !== hiddenNonce ? state : null;
  const fieldId = `reminder-message-${guestInvitationId}`;

  if (visible?.status === "shown") {
    const copied = copyState?.nonce === visible.nonce ? copyState.state : "idle";
    const copyMessage = async () => {
      try {
        await navigator.clipboard.writeText(visible.message);
        setCopyState({ nonce: visible.nonce, state: "copied" });
      } catch {
        setCopyState({ nonce: visible.nonce, state: "failed" });
      }
    };
    return (
      <div className="space-y-2">
        <label htmlFor={fieldId} className="block text-sm font-semibold">
          {interpolate(copy.whatsapp.label, { party: partyLabel })}
        </label>
        <p className="text-muted text-sm">{copy.whatsapp.hint}</p>
        <textarea
          id={fieldId}
          readOnly
          rows={8}
          value={visible.message}
          onFocus={(event) => event.currentTarget.select()}
          className={`${inputClass} text-sm`}
          data-testid="reminder-message"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={copyMessage} className={primaryButtonClass}>
            {copy.whatsapp.copy}
          </button>
          <button type="button" onClick={() => setHiddenNonce(visible.nonce)} className={smallButtonClass}>
            {copy.whatsapp.hide}
          </button>
        </div>
        <p aria-live="polite" className="min-h-5 text-sm">
          {copied === "copied" ? copy.whatsapp.copied : null}
          {copied === "failed" ? <span className="text-danger">{copy.whatsapp.copyFailed}</span> : null}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <form action={formAction}>
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="guestInvitationId" value={guestInvitationId} />
        <SubmitButton label={copy.whatsapp.prepare} pendingLabel={copy.whatsapp.preparing} variant="secondary" />
      </form>
      {visible ? (
        <div key={visible.nonce} data-testid="reminder-message-result">
          <Notice tone={visible.status === "failed" ? "error" : "info"}>
            {visible.message}
            {visible.status === "unrecoverable"
              ? ` ${canAdministerLink ? personal.regenerateOwner : personal.regenerateCollaborator}`
              : null}
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

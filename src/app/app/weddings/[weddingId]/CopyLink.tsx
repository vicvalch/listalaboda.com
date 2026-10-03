"use client";

import { useState } from "react";

import { inputClass, primaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";

type CopyState = "idle" | "copied" | "failed";

type Props = {
  url: string;
  /** Visible label; defaults to the membership invite's. */
  label?: string;
  /** Input id (unique on the page); defaults to the membership invite's. */
  id?: string;
  testId?: string;
};

/**
 * Shows a freshly created link (a membership invite or a guest link) with a
 * copy button. The link lives only in this component's props/DOM; it is
 * never stored client-side.
 */
export function CopyLink({ url, label, id = "invite-link", testId = "invite-link" }: Props) {
  const { invites } = getMessages();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label ?? invites.linkLabel}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          type="text"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className={`${inputClass} min-w-0 font-mono text-sm`}
          data-testid={testId}
        />
        <button type="button" onClick={copy} className={`${primaryButtonClass} shrink-0`}>
          {invites.copy}
        </button>
      </div>
      <p aria-live="polite" className="min-h-5 text-sm">
        {copyState === "copied" ? invites.copied : null}
        {copyState === "failed" ? <span className="text-danger">{invites.copyFailed}</span> : null}
      </p>
    </div>
  );
}

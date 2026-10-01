"use client";

import { useState } from "react";

import { inputClass, primaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";

type CopyState = "idle" | "copied" | "failed";

/**
 * Shows a freshly created invite link with a copy button. The link lives
 * only in this component's props/DOM; it is never stored client-side.
 */
export function CopyLink({ url }: { url: string }) {
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
      <label htmlFor="invite-link" className="block text-sm font-semibold">
        {invites.linkLabel}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="invite-link"
          type="text"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className={`${inputClass} font-mono text-sm`}
          data-testid="invite-link"
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

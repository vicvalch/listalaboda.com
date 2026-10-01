"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";
import { DEFAULT_INVITE_ROLE, INVITE_ROLES } from "@/lib/membership-invites/validation";

import { createInviteAction, type CreateInviteState } from "./actions";
import { CopyLink } from "./CopyLink";

export function InviteForm({ weddingId }: { weddingId: string }) {
  const [state, formAction] = useActionState<CreateInviteState, FormData>(
    createInviteAction,
    null,
  );
  const { invites, roles } = getMessages();
  const failure = state && !state.ok ? state : null;
  const selectedRole = failure?.values?.role || DEFAULT_INVITE_ROLE;
  const roleErrorId = "invite-role-error";

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-5" noValidate>
        <input type="hidden" name="weddingId" value={weddingId} />
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <fieldset
          className="space-y-3"
          aria-describedby={failure?.fieldErrors?.role ? roleErrorId : undefined}
        >
          <legend className="mb-1 text-sm font-semibold">{invites.roleLegend}</legend>
          {INVITE_ROLES.map((role) => (
            <label
              key={role}
              className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="role"
                value={role}
                defaultChecked={role === selectedRole}
                className="mt-1 accent-[var(--accent)]"
              />
              <span>
                <span className="block font-semibold">{roles[role].label}</span>
                <span className="text-muted block text-sm">{roles[role].description}</span>
              </span>
            </label>
          ))}
          {failure?.fieldErrors?.role ? (
            <p id={roleErrorId} className="text-danger text-sm font-medium">
              {failure.fieldErrors.role}
            </p>
          ) : null}
        </fieldset>
        <FormField
          id="invite-email"
          name="email"
          type="email"
          label={invites.emailLabel}
          hint={invites.emailHint}
          autoComplete="off"
          defaultValue={failure?.values?.email}
          error={failure?.fieldErrors?.email}
        />
        <SubmitButton label={invites.submit} pendingLabel={invites.submitting} />
      </form>
      {state?.ok ? (
        <div className="space-y-4 rounded-xl border border-success/40 bg-success-soft p-4">
          <p role="status" className="text-success text-sm font-semibold">
            {invites.created}
          </p>
          <CopyLink url={state.data.inviteUrl} />
        </div>
      ) : null}
    </div>
  );
}

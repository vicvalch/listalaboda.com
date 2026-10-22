"use client";

import { useFormStatus } from "react-dom";

import { primaryButtonClass, secondaryButtonClass } from "./styles";

type SubmitButtonProps = {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary";
  className?: string;
  /** Unavailable regardless of progress (the server still decides). */
  disabled?: boolean;
  /** An accessible name when the visible label alone is ambiguous in a list. */
  ariaLabel?: string;
};

/** Submit button that disables itself and announces progress while pending. */
export function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  className = "",
  disabled = false,
  ariaLabel,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const base = variant === "primary" ? primaryButtonClass : secondaryButtonClass;
  return (
    <button type="submit" disabled={pending || disabled} aria-label={ariaLabel} className={`${base} ${className}`}>
      <span aria-live="polite">{pending ? pendingLabel : label}</span>
    </button>
  );
}

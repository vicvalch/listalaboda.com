import type { ReactNode } from "react";

type NoticeProps = {
  tone: "error" | "success" | "info";
  children: ReactNode;
};

const toneClass: Record<NoticeProps["tone"], string> = {
  error: "border-danger/40 bg-danger-soft text-danger",
  success: "border-success/40 bg-success-soft text-success",
  info: "border-accent/30 bg-accent-soft",
};

/**
 * Inline status message. Errors use role="alert" so they are announced when
 * they appear; other tones are polite status updates.
 */
export function Notice({ tone, children }: NoticeProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-3 text-sm font-medium ${toneClass[tone]}`}
    >
      {children}
    </div>
  );
}

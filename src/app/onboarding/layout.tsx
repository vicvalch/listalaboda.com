import type { ReactNode } from "react";

import { getMessages } from "@/lib/i18n";

// Per-user steps after signing in: never prerender or cache them.
export const dynamic = "force-dynamic";

/** Authenticated first-entry steps (ACCOUNT-01): the brand and one centered panel, no app chrome. */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  const { common } = getMessages();
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <p className="mb-8 text-xl font-semibold tracking-tight">{common.brand}</p>
      <div className="w-full max-w-2xl">{children}</div>
    </main>
  );
}

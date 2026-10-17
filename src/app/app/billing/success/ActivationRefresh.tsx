"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** A few gentle re-reads of the server page while the webhook confirms; then it stops. */
export const ACTIVATION_REFRESH_INTERVAL_MS = 4_000;
export const ACTIVATION_REFRESH_MAX = 8;

type ActivationRefreshProps = {
  hint: string;
  slow: string;
};

/**
 * Re-renders the success page (a server read of the database) at most
 * `ACTIVATION_REFRESH_MAX` times. It never asks Stripe and never decides
 * anything: once the page renders the confirmed state, this component is
 * gone. After the last attempt it says confirmation is slow and stops.
 */
export function ActivationRefresh({ hint, slow }: ActivationRefreshProps) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (attempts >= ACTIVATION_REFRESH_MAX) return;
    const timer = window.setTimeout(() => {
      router.refresh();
      setAttempts((count) => count + 1);
    }, ACTIVATION_REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [attempts, router]);

  return (
    <p className="text-muted text-sm" aria-live="polite">
      {attempts >= ACTIVATION_REFRESH_MAX ? slow : hint}
    </p>
  );
}

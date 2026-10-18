import type { CoupleBillingStatus, PlannerBillingStatus } from "@/lib/billing/entitlements";
import { TERMINAL_SUBSCRIPTION_STATUSES, subscriptionGrantsAccess } from "@/lib/billing/plans";

/**
 * What the billing page shows (BILLING-01), derived from the DATABASE state
 * only. Pure: no clock, no copy, no Stripe call. The entitlement decides
 * "active"; subscription and purchase rows only add detail and choose the
 * one action offered.
 */

export type PlannerBillingView = Readonly<{
  kind: "planner";
  state: "active" | "trialing" | "problem" | "none";
  /** ISO; the current period's end, when known. */
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  action: "subscribe" | "manage" | null;
  /** Any subscription row, in any status (BILLING-02: trials are for a first subscription only). */
  everSubscribed: boolean;
}>;

export type CoupleBillingView = Readonly<{
  kind: "couple";
  state: "active" | "pending" | "none";
  /** ISO; when the payment was confirmed. */
  paidAt: string | null;
  action: "buy" | null;
}>;

/** `available` = billing is configured (else no action is offered). */
export function plannerBillingView(status: PlannerBillingStatus, available: boolean): PlannerBillingView {
  const everSubscribed = status.subscriptions.length > 0;
  const granting = status.subscriptions.find((s) => subscriptionGrantsAccess(s.status)) ?? null;
  if (status.entitlement === "active") {
    return {
      kind: "planner",
      state: granting?.status === "trialing" ? "trialing" : "active",
      periodEnd: granting?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: granting?.cancelAtPeriodEnd ?? false,
      action: available ? "manage" : null,
      everSubscribed,
    };
  }
  // Alive in Stripe but not granting (past_due, unpaid, paused, incomplete): fixed in the portal.
  const alive = status.subscriptions.find((s) => !TERMINAL_SUBSCRIPTION_STATUSES.includes(s.status)) ?? null;
  if (alive) {
    return {
      kind: "planner",
      state: "problem",
      periodEnd: null,
      cancelAtPeriodEnd: false,
      action: available ? "manage" : null,
      everSubscribed,
    };
  }
  return {
    kind: "planner",
    state: "none",
    periodEnd: null,
    cancelAtPeriodEnd: false,
    action: available ? "subscribe" : null,
    everSubscribed,
  };
}

/**
 * Batch 1: the account has never been charged, so "no se te ha cobrado
 * nada" is true: a planner with no subscription row ever (a canceled or
 * expired one doesn't count), a couple with no paid or pending purchase.
 */
export function isNeverCharged(view: PlannerBillingView | CoupleBillingView): boolean {
  return view.kind === "planner" ? view.state === "none" && !view.everSubscribed : view.state === "none";
}

export function coupleBillingView(status: CoupleBillingStatus, available: boolean): CoupleBillingView {
  if (status.entitlement === "active") {
    const paid = status.purchases.find((p) => p.status === "paid") ?? null;
    return { kind: "couple", state: "active", paidAt: paid?.purchasedAt ?? null, action: null };
  }
  // A completed Checkout whose delayed payment hasn't settled: never offer a second payment.
  if (status.purchases.some((p) => p.status === "pending")) {
    return { kind: "couple", state: "pending", paidAt: null, action: null };
  }
  return { kind: "couple", state: "none", paidAt: null, action: available ? "buy" : null };
}

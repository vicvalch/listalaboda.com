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
  /** What happens next to the granting subscription (null = nothing to say). */
  renewal: PlannerRenewal;
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

/**
 * QA-03a: the next thing Stripe will do to a GRANTING subscription. Stripe
 * schedules a cancellation either with `cancel_at_period_end` (it ends when
 * the current period ends) or with `cancel_at`, a timestamp that may fall
 * before, at or after the current period's end. After it, the subscription
 * still renews (and is charged) at the period's end first, then ends at
 * `cancel_at`: never "no se renovará" then. ISO strings in, ISO strings out.
 */
export type PlannerRenewal =
  | Readonly<{ kind: "renews"; on: string }>
  | Readonly<{ kind: "ends"; on: string }>
  | Readonly<{ kind: "renews_then_ends"; renewsOn: string; endsOn: string }>
  | null;

export function plannerRenewal(subscription: {
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
}): PlannerRenewal {
  const { currentPeriodEnd: periodEnd, cancelAtPeriodEnd, cancelAt } = subscription;
  if (cancelAt !== null && (periodEnd === null || Date.parse(cancelAt) <= Date.parse(periodEnd))) {
    return { kind: "ends", on: cancelAt };
  }
  if (cancelAtPeriodEnd) return periodEnd === null ? null : { kind: "ends", on: periodEnd };
  if (cancelAt !== null && periodEnd !== null) return { kind: "renews_then_ends", renewsOn: periodEnd, endsOn: cancelAt };
  return periodEnd === null ? null : { kind: "renews", on: periodEnd };
}

/** `available` = billing is configured (else no action is offered). */
export function plannerBillingView(status: PlannerBillingStatus, available: boolean): PlannerBillingView {
  const everSubscribed = status.subscriptions.length > 0;
  const granting = status.subscriptions.find((s) => subscriptionGrantsAccess(s.status)) ?? null;
  if (status.entitlement === "active") {
    return {
      kind: "planner",
      state: granting?.status === "trialing" ? "trialing" : "active",
      renewal: granting ? plannerRenewal(granting) : null,
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
      renewal: null,
      action: available ? "manage" : null,
      everSubscribed,
    };
  }
  return {
    kind: "planner",
    state: "none",
    renewal: null,
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

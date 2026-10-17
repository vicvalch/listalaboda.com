import { TEST_STRIPE_WEBHOOK_SECRET } from "../../src/test/fixtures/stripe-webhook";

/**
 * BILLING-01 E2E configuration: FAKE, test-only Stripe values (their text
 * says so) and the local stand-in (`stripe-stand-in.mjs`). Nothing here is a
 * Stripe credential; the app only accepts the stand-in with a localhost origin.
 */
export const STRIPE_STAND_IN_PORT = 12117;
export const STRIPE_STAND_IN_ORIGIN = `http://127.0.0.1:${STRIPE_STAND_IN_PORT}`;
export const E2E_STRIPE_SECRET_KEY = "sk_test_TESTONLYe2eStandInNotAStripeKey";
export const E2E_STRIPE_WEBHOOK_SECRET = TEST_STRIPE_WEBHOOK_SECRET;
export const E2E_PLANNER_PRICE_ID = "price_TESTONLYe2ePlannerMonthly";
export const E2E_COUPLE_PRICE_ID = "price_TESTONLYe2eCoupleOneTime";

export type StandInSession = {
  id: string;
  mode: "subscription" | "payment";
  status: string;
  payment_status: string;
  customer: string;
  client_reference_id: string | null;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
  subscriptionMetadata: Record<string, string> | null;
  paymentIntentMetadata: Record<string, string> | null;
  subscription: string | null;
  lineItems: { price: { id: string }; quantity: number }[];
};

async function control<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${STRIPE_STAND_IN_ORIGIN}${path}`, init);
  if (!response.ok) throw new Error(`stand-in ${path}: ${response.status}`);
  return (await response.json()) as T;
}

export const standIn = {
  sessions: () => control<StandInSession[]>("/__e2e/sessions"),
  session: async (id: string) => (await standIn.sessions()).find((s) => s.id === id) ?? null,
  complete: (id: string, paymentStatus = "paid") =>
    control<StandInSession>(`/__e2e/sessions/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ paymentStatus }),
    }),
  setSubscription: (id: string, fields: Record<string, unknown>) =>
    control(`/__e2e/subscriptions/${id}`, { method: "POST", body: JSON.stringify(fields) }),
  portalSessions: () => control<{ customer: string; return_url: string }[]>("/__e2e/portal-sessions"),
};

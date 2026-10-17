import "server-only";

import Stripe from "stripe";

import type {
  BillingGateway,
  BillingObjectMetadata,
  CheckoutSessionSnapshot,
  RetrieveResult,
  SubscriptionSnapshot,
} from "@/lib/billing/gateway";
import { BILLING_METADATA, parseEntitlementKey, parseSubscriptionStatus } from "@/lib/billing/plans";
import { getAppOrigin, isLocalOrigin } from "@/lib/http/app-origin";

/**
 * The Stripe implementation of `BillingGateway` (BILLING-01, ADR-021). The
 * ONLY module that reads `process.env.STRIPE_SECRET_KEY` (ESLint-enforced)
 * and the only one that imports the Stripe SDK's client.
 *
 * Hosted Checkout and the Customer Portal are created server-side, so no
 * publishable key exists anywhere. Stripe objects are normalized to the few
 * fields the application reads (`@/lib/billing/gateway`); errors, payloads
 * and the key never leave this module, and nothing is logged.
 *
 * `STRIPE_API_BASE` (optional) points the SDK at a LOCAL Stripe stand-in for
 * the E2E suite: refused unless both it and `APP_ORIGIN` are localhost, so a
 * deployment can't be redirected to another API host by configuration.
 */

const SECRET_KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9_]{10,250}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_ID_PATTERN = /^[a-z]{2,8}_[A-Za-z0-9_]{1,250}$/;

export type StripeGatewaySettings = Readonly<{
  secretKey: string;
  /** Local stand-in only (E2E). */
  apiBase?: Readonly<{ protocol: "http" | "https"; host: string; port: number }>;
}>;

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Pure: the gateway settings, or null when not configured or not acceptable. */
export function parseStripeGatewaySettings(source: EnvSource, appOrigin: string | null): StripeGatewaySettings | null {
  const secretKey = source.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!SECRET_KEY_PATTERN.test(secretKey)) return null;
  const baseRaw = source.STRIPE_API_BASE?.trim() ?? "";
  if (!baseRaw) return { secretKey };

  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    return null;
  }
  if (!appOrigin || !isLocalOrigin(appOrigin)) return null;
  if (!isLocalOrigin(base.origin) || base.origin !== baseRaw.replace(/\/$/, "")) return null;
  const protocol = base.protocol === "https:" ? "https" : "http";
  const port = Number(base.port || (protocol === "https" ? 443 : 80));
  return { secretKey, apiBase: { protocol, host: base.hostname, port } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function idOf(value: unknown): string | null {
  const id = typeof value === "string" ? value : isRecord(value) ? value.id : null;
  return typeof id === "string" && STRIPE_ID_PATTERN.test(id) ? id : null;
}

function metadataOf(value: unknown): BillingObjectMetadata {
  const metadata = isRecord(value) ? value : {};
  const userId = metadata[BILLING_METADATA.userId];
  return {
    userId: typeof userId === "string" && UUID_PATTERN.test(userId) ? userId.toLowerCase() : null,
    entitlementKey: parseEntitlementKey(metadata[BILLING_METADATA.entitlement]),
  };
}

function firstItem(list: unknown): Record<string, unknown> | null {
  if (!isRecord(list) || !Array.isArray(list.data)) return null;
  const item: unknown = list.data[0];
  return isRecord(item) ? item : null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && (error.code === "resource_missing" || error.statusCode === 404);
}

/** Normalizes a Stripe subscription (current period end lives on the item since API 2025-03-31). */
export function toSubscriptionSnapshot(subscription: unknown): SubscriptionSnapshot | null {
  if (!isRecord(subscription)) return null;
  const id = idOf(subscription.id);
  const customerId = idOf(subscription.customer);
  if (!id || !customerId) return null;
  const item = firstItem(subscription.items);
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;
  return {
    id,
    customerId,
    status: parseSubscriptionStatus(subscription.status),
    priceId: idOf(item?.price),
    currentPeriodEnd: typeof periodEnd === "number" && Number.isFinite(periodEnd) ? periodEnd : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    metadata: metadataOf(subscription.metadata),
  };
}

export function toCheckoutSessionSnapshot(session: unknown): CheckoutSessionSnapshot | null {
  if (!isRecord(session)) return null;
  const id = idOf(session.id);
  const mode = session.mode;
  if (!id || (mode !== "payment" && mode !== "subscription" && mode !== "setup")) return null;
  return {
    id,
    mode,
    status: typeof session.status === "string" ? session.status : null,
    paymentStatus: typeof session.payment_status === "string" ? session.payment_status : "unpaid",
    customerId: idOf(session.customer),
    subscriptionId: idOf(session.subscription),
    paymentIntentId: idOf(session.payment_intent),
    priceId: idOf(firstItem(session.line_items)?.price),
    metadata: metadataOf(session.metadata),
  };
}

function checkoutUrl(value: unknown, local: boolean): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    return local && url.protocol === "http:" && isLocalOrigin(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Builds the gateway from explicit settings (the factory below, and tests). */
export function createStripeGateway(settings: StripeGatewaySettings): BillingGateway {
  const stripe = new Stripe(settings.secretKey, {
    // Safe: Stripe adds an idempotency key to every retried POST itself.
    maxNetworkRetries: 2,
    timeout: 10_000,
    telemetry: false,
    ...(settings.apiBase
      ? { protocol: settings.apiBase.protocol, host: settings.apiBase.host, port: settings.apiBase.port }
      : {}),
  });
  const local = settings.apiBase !== undefined;

  return {
    async createCustomer({ userId, accountType, idempotencyKey }) {
      try {
        const customer = await stripe.customers.create(
          { metadata: { [BILLING_METADATA.userId]: userId, [BILLING_METADATA.accountType]: accountType } },
          { idempotencyKey },
        );
        const id = idOf(customer.id);
        return id ? { id } : null;
      } catch {
        return null;
      }
    },

    async createCheckoutSession(input) {
      const metadata = {
        [BILLING_METADATA.userId]: input.userId,
        [BILLING_METADATA.accountType]: input.accountType,
        [BILLING_METADATA.entitlement]: input.entitlementKey,
      };
      try {
        const session = await stripe.checkout.sessions.create({
          mode: input.mode,
          customer: input.customerId,
          client_reference_id: input.userId,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          locale: "es",
          metadata,
          ...(input.mode === "subscription"
            ? { subscription_data: { metadata } }
            : { payment_intent_data: { metadata } }),
        });
        const id = idOf(session.id);
        const url = checkoutUrl(session.url, local);
        return id && url ? { id, url } : null;
      } catch {
        return null;
      }
    },

    async createPortalSession({ customerId, returnUrl }) {
      try {
        const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
        const url = checkoutUrl(session.url, local);
        return url ? { url } : null;
      } catch {
        return null;
      }
    },

    async retrieveSubscription(id): Promise<RetrieveResult<SubscriptionSnapshot>> {
      try {
        return toSubscriptionSnapshot(await stripe.subscriptions.retrieve(id));
      } catch (error) {
        return isNotFound(error) ? "not_found" : null;
      }
    },

    async retrieveCheckoutSession(id): Promise<RetrieveResult<CheckoutSessionSnapshot>> {
      try {
        return toCheckoutSessionSnapshot(await stripe.checkout.sessions.retrieve(id, { expand: ["line_items"] }));
      } catch (error) {
        return isNotFound(error) ? "not_found" : null;
      }
    },
  };
}

/** The gateway from the server environment, or null when Stripe isn't configured. */
export function getStripeGateway(): BillingGateway | null {
  const settings = parseStripeGatewaySettings(
    {
      // BILLING-01 (ADR-021): the one sanctioned read of the Stripe secret key.
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_API_BASE: process.env.STRIPE_API_BASE,
    },
    getAppOrigin(),
  );
  return settings ? createStripeGateway(settings) : null;
}

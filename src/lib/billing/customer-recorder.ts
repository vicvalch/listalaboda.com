import "server-only";

import { createClient } from "@supabase/supabase-js";

import { parseRecorderSettings } from "@/lib/email/delivery-recorder";
import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The Stripe Customer mapping's database boundary (BILLING-01, ADR-021 §5):
 * a sanctioned service-role use (ADR-002 §6), separate from every other.
 *
 * Authority: the APPLICATION's own Stripe result, obtained after the user's
 * session authorized starting Checkout (`requireAccountType` in the action,
 * then `@/lib/billing/customers`). The database can't authenticate a Stripe
 * result coming from a client credential, and a client-writable mapping
 * would let anyone attach another person's Stripe Customer to their account
 * (and open its billing portal). So `billing_customers` has no client write
 * privilege and its one writer, `record_billing_customer`, is SECURITY
 * DEFINER and executable ONLY by service_role.
 *
 * Exactly one operation, `record`, one fixed RPC, one user per call. It
 * returns the customer id the database KEEPS (an earlier or concurrent start
 * wins), which the caller must use. The privileged client is created inside
 * and never returned or exported: no `from()`, no generic `rpc(name)`, no
 * authorization. The key is read only here (and in the other named stores),
 * never logged, returned or echoed; missing configuration fails closed.
 */

export interface BillingCustomerRecorder {
  /** The stored customer id for the user, or null (refused, unreachable, unexpected). */
  record(input: Readonly<{ userId: string; stripeCustomerId: string }>): Promise<string | null>;
}

type RecorderSettings = Readonly<{ supabaseUrl: string; serviceRoleKey: string }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]{1,250}$/;

export function createBillingCustomerRecorder({ supabaseUrl, serviceRoleKey }: RecorderSettings): BillingCustomerRecorder {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async record({ userId, stripeCustomerId }) {
      if (!UUID_PATTERN.test(userId) || !CUSTOMER_ID_PATTERN.test(stripeCustomerId)) return null;
      try {
        const { data, error } = await privileged.rpc("record_billing_customer", {
          target_user_id: userId,
          stripe_customer_id: stripeCustomerId,
        });
        if (error || typeof data !== "string" || !CUSTOMER_ID_PATTERN.test(data)) return null;
        return data;
      } catch {
        return null;
      }
    },
  };
}

/** The recorder from the server environment, or null when not configured. */
export function getBillingCustomerRecorder(): BillingCustomerRecorder | null {
  let supabaseUrl: string;
  try {
    supabaseUrl = getPublicEnv().supabaseUrl;
  } catch {
    return null;
  }
  const settings = parseRecorderSettings({
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // ADR-021 §5, ADR-002 §6: a sanctioned read of this key (ESLint allows it in the named stores only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createBillingCustomerRecorder(settings) : null;
}

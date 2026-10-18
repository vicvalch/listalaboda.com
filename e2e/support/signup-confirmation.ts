import { createClient } from "@supabase/supabase-js";

import { signupRedirectUrl } from "../../src/lib/auth/signup-confirmation";
import { E2E_PASSWORD, uniqueEmail } from "./identities";
import { readLocalSupabase } from "./local-supabase";

/**
 * Batch 3 fixtures. The LOCAL stack auto-confirms sign-ups
 * (`enable_confirmations = false`, which ~190 journeys rely on), so a real
 * "Confirm signup" email can't come from the signup form here. Instead:
 *
 * - `createUnconfirmedAccount`: the local Auth admin API creates the account
 *   exactly as a production sign-up leaves it (unconfirmed, with a password).
 *   LOCAL ONLY (`readLocalSupabase` refuses any other host); the app itself
 *   never uses an admin client.
 * - `sendSignupConfirmation`: Supabase Auth's own `resend` of the signup email
 *   with the app's `emailRedirectTo` (`signupRedirectUrl`, what `signupAction`
 *   passes), rendered from `supabase/templates/confirmation.html`, the same
 *   template production uses, into Mailpit. Each send replaces the previous
 *   token, like a retried sign-up does.
 *
 * Confirmation links are bearer credentials: never printed.
 */

export async function createUnconfirmedAccount(label: string): Promise<string> {
  const { apiUrl, secretKey } = readLocalSupabase();
  const admin = createClient(apiUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = uniqueEmail(label);
  const { error } = await admin.auth.admin.createUser({ email, password: E2E_PASSWORD, email_confirm: false });
  if (error) throw new Error(`Could not create the local unconfirmed account: ${error.code ?? error.status}`);
  return email;
}

export async function sendSignupConfirmation(email: string, appOrigin: string, next?: string): Promise<void> {
  const { apiUrl, publishableKey } = readLocalSupabase();
  const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: signupRedirectUrl(appOrigin, next) },
  });
  if (error) throw new Error(`Could not send the local signup confirmation: ${error.code ?? error.status}`);
}

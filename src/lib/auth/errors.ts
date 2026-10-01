import { es } from "@/lib/i18n/messages/es";

/**
 * Maps Supabase Auth failures to user-safe outcomes. Raw Auth messages are
 * never shown: they are English, can change between versions, and some
 * would reveal whether an account exists.
 */

/** The parts of an AuthError we branch on. */
export type AuthFailure = Readonly<{ code?: string | null; status?: number | null }>;

export type SignInOutcome = Readonly<{ formError: string }>;

export function normalizeSignInError(error: AuthFailure): SignInOutcome {
  switch (error.code) {
    // GoTrue only reports email_not_confirmed after the password matched, so
    // this tells nothing to someone who doesn't already hold the password.
    case "email_not_confirmed":
      return { formError: es.auth.login.emailNotConfirmed };
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return { formError: es.auth.rateLimited };
    case "invalid_credentials":
    case "user_not_found":
      return { formError: es.auth.login.invalidCredentials };
    default:
      // 400/422 from the token endpoint are credential problems; anything
      // else is our failure, not the user's.
      return error.status === 400 || error.status === 422
        ? { formError: es.auth.login.invalidCredentials }
        : { formError: es.common.unexpectedError };
  }
}

export type SignUpOutcome =
  | Readonly<{ kind: "confirmation_required" }>
  | Readonly<{ kind: "field"; field: "email" | "password"; message: string }>
  | Readonly<{ kind: "form"; message: string }>;

export function normalizeSignUpError(error: AuthFailure): SignUpOutcome {
  switch (error.code) {
    // Anti-enumeration: an existing account gets the same neutral "check
    // your email" outcome a new one gets when confirmation is required.
    case "user_already_exists":
    case "email_exists":
      return { kind: "confirmation_required" };
    case "weak_password":
      return { kind: "field", field: "password", message: es.auth.signup.weakPassword };
    case "email_address_invalid":
      return { kind: "field", field: "email", message: es.auth.validation.emailInvalid };
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return { kind: "form", message: es.auth.rateLimited };
    default:
      return { kind: "form", message: es.common.unexpectedError };
  }
}

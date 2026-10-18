# Supabase Auth email templates (production)

Hosted Supabase does not read `supabase/config.toml` or `supabase/templates/`: production Auth emails are
project settings in the Supabase Dashboard. The repo files are the source of truth for their content (the local
stack and the E2E suite render exactly them); this page is the manual checklist to mirror them in production.
Each change is an explicit, approved step, done AFTER the code that serves the links is deployed.

## Preconditions (already true since 2026-10-15; re-check)

- Authentication → URL Configuration: **Site URL** = `https://listalaboda.com` (`{{ .SiteURL }}` builds every link).
- Redirect URLs include `https://listalaboda.com/auth/callback**`. Batch 3 needs no new entry: the signup
  `emailRedirectTo` is still `https://listalaboda.com/auth/callback?next=…` (`signupRedirectUrl`).
- Authentication → Sign In / Providers → Email: **Confirm email** ON.
- Custom SMTP (Resend, sender `cuenta@listalaboda.com`) with click tracking / link rewriting OFF, so the link in
  the email is the app's own URL.
- Leave the Auth rate limits as they are (Authentication → Rate Limits). The app relies on them and adds none.

## Confirm signup (Batch 3)

Authentication → Email Templates → **Confirm signup**:

- Subject: `Confirma tu cuenta | ListaLaBoda`
- Body: the full content of `supabase/templates/confirmation.html`, unchanged. Its link must stay exactly
  `{{ .SiteURL }}/auth/confirm/prepare?token_hash={{ .TokenHash }}&redirect_to={{ .RedirectTo }}`; never
  `{{ .ConfirmationURL }}` (a scanner's GET would consume it, and its PKCE exchange only works in the signup browser).

Order: deploy the Batch 3 code first (the template links to `/auth/confirm/prepare`). Emails already sent with
the previous template keep working as before (Supabase verify → `/auth/callback`, same browser only); if such a link
fails after confirming the account, the login page now says to sign in.

## Reset Password (AUTH-RECOVERY-02; subject fix in Batch 3)

Authentication → Email Templates → **Reset Password**:

- Subject: `Restablece tu contraseña | ListaLaBoda` (production still showed Supabase's English default).
- Body: the full content of `supabase/templates/recovery.html`; its link is
  `{{ .SiteURL }}/auth/recovery/prepare?token_hash={{ .TokenHash }}`. Only re-paste it if it differs.

## Verify after saving

1. Sign up with a fresh address on `https://listalaboda.com/signup?next=%2Fapp%2Fbilling`: the email's subject is
   Spanish, its link starts with `https://listalaboda.com/auth/confirm/prepare?token_hash=`.
2. Open it on a different device or browser: the page asks "Confirma tu cuenta"; nothing happens until
   "Confirmar mi cuenta"; then the account-type choice, then `/app/billing`.
3. Request a password reset: the subject is Spanish; the flow is unchanged.

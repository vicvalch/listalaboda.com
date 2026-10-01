import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { TEST_EMAIL_DOMAIN } from "./context";
import { clientAs, ctx, sql } from "./support";

// Real Supabase Auth on the local stack: the session lifecycle LB-04's
// login/logout relies on. Fake, local-only identities.

const PREFIX = "auth-flow-";
const PASSWORD = "local-only-auth-flow-password";

function freshEmail() {
  return `${PREFIX}${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`;
}

function authClient() {
  return createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

afterAll(async () => {
  const pattern = `${PREFIX}%@${TEST_EMAIL_DOMAIN}`;
  await sql(
    `delete from public.weddings w where exists (
       select 1 from public.wedding_memberships m join auth.users u on u.id = m.user_id
       where m.wedding_id = w.id and u.email like $1)`,
    [pattern],
  );
  await sql("delete from auth.users where email like $1", [pattern]);
});

describe("auth session lifecycle (local Supabase Auth)", () => {
  it("sign up → sign in → validated user → sign out → session no longer valid", async () => {
    const email = freshEmail();

    // The local stack auto-confirms (supabase/config.toml), so sign-up returns
    // a session: the "session immediately" branch of the signup flow.
    const signUp = await authClient().auth.signUp({ email, password: PASSWORD });
    expect(signUp.error).toBeNull();
    expect(signUp.data.session).not.toBeNull();

    const supabase = authClient();
    const signIn = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
    expect(signIn.error).toBeNull();
    const accessToken = signIn.data.session?.access_token ?? "";

    const { data: userData, error: userError } = await supabase.auth.getUser();
    expect(userError).toBeNull();
    expect(userData.user?.email).toBe(email);

    const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
    expect(signOutError).toBeNull();

    // The old access token is rejected by the Auth server: the session is gone.
    const afterSignOut = await authClient().auth.getUser(accessToken);
    expect(afterSignOut.data.user).toBeNull();
    expect(afterSignOut.error).not.toBeNull();
  });

  it("a signed-out session can't be refreshed or validated", async () => {
    const email = freshEmail();
    const supabase = authClient();
    await supabase.auth.signUp({ email, password: PASSWORD });
    const { data } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
    const accessToken = data.session?.access_token ?? "";
    const refreshToken = data.session?.refresh_token ?? "";
    await supabase.auth.signOut({ scope: "local" });

    // The refresh token can't mint a new session either.
    const refreshed = await authClient().auth.refreshSession({ refresh_token: refreshToken });
    expect(refreshed.data.session).toBeNull();

    // The app's identity check (auth.getUser, used by every protected page
    // and action) rejects the old access token.
    expect((await authClient().auth.getUser(accessToken)).data.user).toBeNull();

    // Known platform limit, asserted so it can't be forgotten: the Data API
    // validates JWTs statelessly, so a copied access token keeps working
    // there until it expires (jwt_expiry, 1h). Logout clears it from the
    // browser; the app never relies on the Data API alone for identity.
    const stale = clientAs({ id: "", email, accessToken, refreshToken });
    const { error } = await stale.from("weddings").select("id").limit(1);
    expect(error).toBeNull();
  });

  it("wrong password and unknown account fail with the same error code", async () => {
    const email = freshEmail();
    await authClient().auth.signUp({ email, password: PASSWORD });

    const wrong = await authClient().auth.signInWithPassword({ email, password: "nope-nope-nope" });
    const unknown = await authClient().auth.signInWithPassword({
      email: freshEmail(),
      password: "nope-nope-nope",
    });
    expect(wrong.error?.code).toBe("invalid_credentials");
    expect(unknown.error?.code).toBe(wrong.error?.code);
  });

  it("re-registering an address reports user_already_exists locally (mapped to a neutral UX)", async () => {
    const email = freshEmail();
    await authClient().auth.signUp({ email, password: PASSWORD });
    const again = await authClient().auth.signUp({ email, password: PASSWORD });
    // With auto-confirm the Auth server reveals this; the app maps it to the
    // same "check your email" outcome (src/lib/auth/errors.ts).
    expect(again.error?.code).toBe("user_already_exists");
  });
});

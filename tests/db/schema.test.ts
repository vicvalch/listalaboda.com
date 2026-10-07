import { describe, expect, it } from "vitest";

import { sql } from "./support";

// Catalog checks complement, never replace, the behavioral RLS tests: they
// guard properties that are easy to regress silently in a later migration.

const TABLES = [
  "weddings",
  "wedding_memberships",
  "membership_invites",
  "checklist_templates",
  "checklist_template_items",
  "wedding_checklist_template_applications",
  "checklist_items",
  "guest_invitations",
  "guests",
  "rsvps",
  "content_sections",
  "wedding_publications",
  // LB-17 (ADR-010)
  "wedding_rsvp_reminder_policies",
  "automatic_rsvp_reminders",
  // LB-18.1 (ADR-011)
  "email_deliveries",
  // LB-18.2 (ADR-011 §7)
  "email_delivery_events",
];

/**
 * Callable without an account: the guest capability (by token hash only)
 * and the published website (by public slug only).
 */
const ANON_FUNCTIONS = [
  "public.get_guest_invitation",
  "public.get_guest_invitation_site_slug",
  "public.get_published_wedding_site",
  "public.submit_guest_rsvp",
];

describe("schema guarantees", () => {
  it("RLS is enabled on every product table", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relname = any($1)
       order by c.relname`,
      [TABLES],
    );
    expect(rows).toEqual(
      [...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })),
    );
  });

  it("anon holds no privileges on any product table", async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'anon' and table_schema = 'public' and table_name = any($1)`,
      [TABLES],
    );
    expect(rows).toEqual([]);
    const columns = await sql(
      `select 1 from information_schema.column_privileges
       where grantee = 'anon' and table_schema = 'public' and table_name = any($1)`,
      [TABLES],
    );
    expect(columns).toEqual([]);
  });

  it("authenticated can INSERT only into membership invites, checklist items, the guest list and site content", async () => {
    const rows = await sql<{ table_name: string }>(
      `select table_name from information_schema.column_privileges
       where grantee = 'authenticated' and privilege_type = 'INSERT'
         and table_schema = 'public' and table_name = any($1)
       group by table_name`,
      [TABLES],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "checklist_items",
      "content_sections",
      // LB-13: no guest_invitations — parties come only from create_guest_invitation.
      "guests",
      "membership_invites",
    ]);
  });

  it("every function pins search_path; only the guest token and public site functions are executable by anon", async () => {
    const rows = await sql<{
      name: string;
      security_definer: boolean;
      config: string[] | null;
      anon_exec: boolean;
      public_exec: boolean;
      authenticated_exec: boolean;
    }>(
      `select p.pronamespace::regnamespace || '.' || p.proname as name,
              p.prosecdef as security_definer,
              p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec,
              coalesce(exists (
                select 1 from aclexplode(p.proacl) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ), true) as public_exec,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec
       from pg_proc p
       where (p.pronamespace = 'private'::regnamespace)
          or (p.pronamespace = 'public'::regnamespace
              and p.proname in ('create_wedding', 'accept_membership_invite',
                                'initialize_wedding_checklist', 'set_wedding_display_name',
                                'create_guest_invitation', 'get_guest_invitation',
                                'submit_guest_rsvp', 'save_wedding_site_section',
                                'set_wedding_site_slug', 'publish_wedding_site',
                                'unpublish_wedding_site', 'get_published_wedding_site',
                                'get_guest_invitation_site_slug', 'guest_invitation_link_is_current',
                                'record_guest_invitation_email', 'get_rsvp_confirmation_email_context',
                                'record_rsvp_confirmation_email', 'rotate_guest_invitation_link',
                                'get_guest_invitation_recovery_envelope', 'record_rsvp_reminder_email',
                                'revoke_guest_invitation_link', 'get_wedding_activity',
                                'set_rsvp_reminder_policy', 'claim_automatic_rsvp_reminders',
                                'prepare_automatic_rsvp_reminder', 'begin_automatic_rsvp_reminder_send',
                                'record_automatic_rsvp_reminder_email', 'finish_automatic_rsvp_reminder',
                                'ingest_email_delivery_event'))
       order by 1`,
    );

    expect(rows.map((r) => r.name)).toEqual([
      "private.assign_checklist_item_sort_order",
      "private.automatic_rsvp_reminder_due_at",
      "private.automatic_rsvp_reminder_ineligibility",
      "private.automatic_rsvp_reminder_party_due_at",
      "private.email_delivery_status_rank",
      "private.enforce_guest_invitation_capability_secret",
      "private.enforce_guest_invitation_has_guest",
      "private.enforce_wedding_has_owner",
      "private.guard_email_deliveries",
      "private.guard_email_delivery_events",
      "private.guard_guest_invitation_link",
      "private.guard_membership_invite_state",
      "private.guard_wedding_activity",
      "private.guest_invitation_expires_at",
      "private.has_wedding_role",
      "private.is_wedding_member",
      "private.record_email_delivery",
      "private.record_guest_invitation_contact_email_change",
      "private.require_wedding_site_owner",
      "private.set_updated_at",
      "private.stamp_checklist_item_completion",
      "private.validate_wedding_time_zone",
      "public.accept_membership_invite",
      "public.begin_automatic_rsvp_reminder_send",
      "public.claim_automatic_rsvp_reminders",
      "public.create_guest_invitation",
      "public.create_wedding",
      "public.finish_automatic_rsvp_reminder",
      "public.get_guest_invitation",
      "public.get_guest_invitation_recovery_envelope",
      "public.get_guest_invitation_site_slug",
      "public.get_published_wedding_site",
      "public.get_rsvp_confirmation_email_context",
      "public.get_wedding_activity",
      "public.guest_invitation_link_is_current",
      "public.ingest_email_delivery_event",
      "public.initialize_wedding_checklist",
      "public.prepare_automatic_rsvp_reminder",
      "public.publish_wedding_site",
      "public.record_automatic_rsvp_reminder_email",
      "public.record_guest_invitation_email",
      "public.record_rsvp_confirmation_email",
      "public.record_rsvp_reminder_email",
      "public.revoke_guest_invitation_link",
      "public.rotate_guest_invitation_link",
      "public.save_wedding_site_section",
      "public.set_rsvp_reminder_policy",
      "public.set_wedding_display_name",
      "public.set_wedding_site_slug",
      "public.submit_guest_rsvp",
      "public.unpublish_wedding_site",
    ]);
    for (const fn of rows) {
      expect(fn.config, fn.name).toEqual(['search_path=""']);
      expect(fn.anon_exec, fn.name).toBe(ANON_FUNCTIONS.includes(fn.name));
      expect(fn.public_exec, fn.name).toBe(false);
    }

    const callable = rows.filter((r) => r.authenticated_exec).map((r) => r.name);
    expect(callable).toEqual([
      "private.has_wedding_role",
      "private.is_wedding_member",
      "public.accept_membership_invite",
      "public.create_guest_invitation",
      "public.create_wedding",
      "public.get_guest_invitation",
      "public.get_guest_invitation_recovery_envelope",
      "public.get_guest_invitation_site_slug",
      "public.get_published_wedding_site",
      "public.get_wedding_activity",
      "public.guest_invitation_link_is_current",
      "public.initialize_wedding_checklist",
      "public.publish_wedding_site",
      "public.revoke_guest_invitation_link",
      "public.rotate_guest_invitation_link",
      "public.save_wedding_site_section",
      // LB-17: owner-checked inside; the five scheduler functions are NOT here.
      "public.set_rsvp_reminder_policy",
      "public.set_wedding_display_name",
      "public.set_wedding_site_slug",
      "public.submit_guest_rsvp",
      "public.unpublish_wedding_site",
    ]);

    // SECURITY DEFINER only where a narrow boundary needs it. The organizer
    // party and site-section RPCs run as the caller (RLS applies).
    const definer = rows.filter((r) => r.security_definer).map((r) => r.name);
    expect(definer).toContain("public.get_guest_invitation");
    expect(definer).toContain("public.submit_guest_rsvp");
    expect(definer).toContain("public.get_published_wedding_site");
    expect(definer).toContain("public.publish_wedding_site");
    // LB-11: token_hash and the send metadata aren't client-accessible.
    expect(definer).toContain("public.guest_invitation_link_is_current");
    expect(definer).toContain("public.record_guest_invitation_email");
    // LB-12 (ADR-005): service_role-only, scoped to one party.
    expect(definer).toContain("public.get_rsvp_confirmation_email_context");
    expect(definer).toContain("public.record_rsvp_confirmation_email");
    // LB-14 (ADR-007): service_role-only, scoped to one party's live link.
    expect(definer).toContain("public.record_rsvp_reminder_email");
    // LB-18.2 (ADR-011 §7): service_role-only, provider-signature-authenticated.
    expect(definer).toContain("public.ingest_email_delivery_event");
    // LB-13 (ADR-006): no client role can read or write token_hash/envelopes,
    // so the two writers and the recovery read check membership themselves.
    expect(definer).toContain("public.get_guest_invitation_recovery_envelope");
    expect(definer).toContain("public.rotate_guest_invitation_link");
    expect(definer).toContain("public.create_guest_invitation");
    expect(definer).not.toContain("public.save_wedding_site_section");
    // LB-15 (ADR-008): revocation's one door checks the owner role itself and
    // writes the history row; the history read runs as the caller (RLS).
    expect(definer).toContain("public.revoke_guest_invitation_link");
    expect(definer).not.toContain("public.get_wedding_activity");
    // LB-17 (ADR-010): the policy writer checks the owner role itself; the
    // five scheduler functions are service_role-only state transitions.
    for (const fn of [
      "public.set_rsvp_reminder_policy",
      "public.claim_automatic_rsvp_reminders",
      "public.prepare_automatic_rsvp_reminder",
      "public.begin_automatic_rsvp_reminder_send",
      "public.record_automatic_rsvp_reminder_email",
      "public.finish_automatic_rsvp_reminder",
    ]) {
      expect(definer).toContain(fn);
    }
  });

  it("no function takes a caller-supplied user id", async () => {
    const rows = await sql<{ name: string; args: string }>(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p
       where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
         and p.proname in ('create_wedding', 'accept_membership_invite',
                           'is_wedding_member', 'has_wedding_role',
                           'initialize_wedding_checklist', 'set_wedding_display_name',
                           'create_guest_invitation', 'get_guest_invitation',
                           'submit_guest_rsvp', 'save_wedding_site_section',
                           'set_wedding_site_slug', 'publish_wedding_site',
                           'unpublish_wedding_site', 'get_published_wedding_site',
                           'get_guest_invitation_site_slug', 'guest_invitation_link_is_current',
                           'record_guest_invitation_email', 'rotate_guest_invitation_link',
                           'get_guest_invitation_recovery_envelope', 'record_rsvp_reminder_email',
                           'revoke_guest_invitation_link', 'get_wedding_activity',
                           'set_rsvp_reminder_policy', 'record_automatic_rsvp_reminder_email',
                           'begin_automatic_rsvp_reminder_send')
       order by 1`,
    );
    expect(rows).toEqual([
      { name: "accept_membership_invite", args: "invite_token_hash text" },
      // LB-17 (ADR-010 §2): the scheduler is the system; it never names a user.
      {
        name: "begin_automatic_rsvp_reminder_send",
        args: "target_occurrence_id uuid, occurrence_claim_token uuid, expected_token_hash text, expected_recipient text",
      },
      {
        name: "create_guest_invitation",
        args: "target_wedding_id uuid, party_label text, invitation_token_hash text, invitation_token_ciphertext text, guest_names text[], party_contact_email text",
      },
      {
        name: "create_wedding",
        args: "wedding_name text, wedding_date date, wedding_city text, wedding_time_zone text",
      },
      { name: "get_guest_invitation", args: "invitation_token_hash text" },
      {
        name: "get_guest_invitation_recovery_envelope",
        args: "target_wedding_id uuid, target_invitation_id uuid",
      },
      { name: "get_guest_invitation_site_slug", args: "invitation_token_hash text" },
      { name: "get_published_wedding_site", args: "site_slug text" },
      { name: "get_wedding_activity", args: "target_wedding_id uuid, max_events integer" },
      {
        name: "guest_invitation_link_is_current",
        args: "target_wedding_id uuid, target_invitation_id uuid, invitation_token_hash text",
      },
      { name: "has_wedding_role", args: "target_wedding_id uuid, allowed_roles wedding_role[]" },
      { name: "initialize_wedding_checklist", args: "target_wedding_id uuid" },
      { name: "is_wedding_member", args: "target_wedding_id uuid" },
      { name: "publish_wedding_site", args: "target_wedding_id uuid" },
      {
        name: "record_automatic_rsvp_reminder_email",
        args: "target_occurrence_id uuid, occurrence_claim_token uuid, invitation_token_hash text, recipient text, provider_message_id text",
      },
      // LB-15 (ADR-008): the ONE exception — the two service_role-only
      // recorders take the acting member for ATTRIBUTION (activity history),
      // never authority. Only the server can call them, it passes its own
      // auth.getUser() id, and they re-check membership (asserted below).
      {
        name: "record_guest_invitation_email",
        args: "target_wedding_id uuid, target_invitation_id uuid, invitation_token_hash text, recipient text, provider_message_id text, acting_user_id uuid",
      },
      {
        name: "record_rsvp_reminder_email",
        args: "target_wedding_id uuid, target_invitation_id uuid, invitation_token_hash text, recipient text, provider_message_id text, acting_user_id uuid",
      },
      { name: "revoke_guest_invitation_link", args: "target_wedding_id uuid, target_invitation_id uuid" },
      {
        name: "rotate_guest_invitation_link",
        args: "target_wedding_id uuid, target_invitation_id uuid, invitation_token_hash text, invitation_token_ciphertext text",
      },
      {
        name: "save_wedding_site_section",
        args: "target_wedding_id uuid, section_kind content_section_kind, section_title text, section_body text, section_visible boolean",
      },
      {
        name: "set_rsvp_reminder_policy",
        args: "target_wedding_id uuid, reminders_enabled boolean, reminder_days_before integer",
      },
      {
        name: "set_wedding_display_name",
        args: "target_wedding_id uuid, new_display_name text",
      },
      { name: "set_wedding_site_slug", args: "target_wedding_id uuid, new_slug text" },
      { name: "submit_guest_rsvp", args: "invitation_token_hash text, responses jsonb" },
      { name: "unpublish_wedding_site", args: "target_wedding_id uuid" },
    ]);

    // Anywhere in public/private: a function that takes a user id is never
    // executable by a client role (so no browser can name an actor).
    const userIdTakers = await sql<{ name: string; anon: boolean; authenticated: boolean }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
       from pg_proc p
       where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
         and exists (select 1 from unnest(p.proargnames) a where a ~ 'user_id')
       order by 1`,
    );
    expect(userIdTakers).toEqual([
      { name: "record_guest_invitation_email", anon: false, authenticated: false },
      { name: "record_rsvp_reminder_email", anon: false, authenticated: false },
    ]);
  });

  it("checklist statuses are exactly pending, done and not_applicable", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.checklist_item_status'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["pending", "done", "not_applicable"]);
  });

  it("authenticated has no privileges at all on template tables", async () => {
    const rows = await sql(
      `select 1 from information_schema.role_table_grants
       where grantee in ('anon', 'authenticated') and table_schema = 'public'
         and table_name in ('checklist_templates', 'checklist_template_items')
       union all
       select 1 from information_schema.column_privileges
       where grantee in ('anon', 'authenticated') and table_schema = 'public'
         and table_name in ('checklist_templates', 'checklist_template_items')`,
    );
    expect(rows).toEqual([]);
  });

  it("membership roles are exactly owner and collaborator", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.wedding_role'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["owner", "collaborator"]);
  });

  it("weddings have no owner column; ownership lives only in memberships", async () => {
    const rows = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'weddings' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "id",
      "created_by",
      "name",
      "wedding_date",
      "created_at",
      "updated_at",
      "city",
      "time_zone",
    ]);
  });

  it("there is exactly one create_wedding (no ambiguous overloads)", async () => {
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n from pg_proc
       where pronamespace = 'public'::regnamespace and proname = 'create_wedding'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("authenticated may UPDATE only name, date, city and time zone of weddings", async () => {
    const rows = await sql<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'authenticated' and privilege_type = 'UPDATE'
         and table_schema = 'public' and table_name = 'weddings'
       order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["city", "name", "time_zone", "wedding_date"]);
  });

  it("no overdue state is persisted anywhere", async () => {
    const rows = await sql(
      `select 1 from information_schema.columns
       where table_schema = 'public'
         and (column_name ilike '%overdue%' or column_name ilike '%effective%'
              or column_name in ('late', 'is_late', 'late_status'))`,
    );
    expect(rows).toEqual([]);
  });

  it("no party size, plus-one or response counter is stored", async () => {
    const rows = await sql(
      `select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name in ('weddings', 'guest_invitations', 'guests', 'rsvps')
         and (column_name ilike '%party_size%' or column_name ilike '%plus_one%'
              or column_name ilike '%count%' or column_name ilike '%max_guests%'
              or column_name in ('email', 'phone', 'user_id', 'auth_user_id', 'membership_id'))`,
    );
    expect(rows).toEqual([]);
  });

  it("guest link expiry is derived, never stored", async () => {
    const rows = await sql(
      `select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'guest_invitations'
         and column_name ilike '%expire%'`,
    );
    expect(rows).toEqual([]);
  });

  it("contact data lives only on the party: one optional contact email, nothing on guests or RSVPs", async () => {
    const rows = await sql<{ column_name: string }>(
      `select table_name || '.' || column_name as column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in ('weddings', 'guest_invitations', 'guests', 'rsvps',
                            'content_sections', 'wedding_publications')
         and (column_name ilike '%email%' or column_name ilike '%phone%' or column_name ilike '%contact%')
       order by 1`,
    );
    // The address itself, and the latest sends' metadata (recipient
    // included): the invitation (LB-11), the RSVP confirmation (LB-12) and
    // the RSVP reminder (LB-14). Still no phone or WhatsApp number.
    expect(rows.map((r) => r.column_name)).toEqual([
      "guest_invitations.contact_email",
      "guest_invitations.invitation_email_provider_id",
      "guest_invitations.invitation_email_sent_at",
      "guest_invitations.invitation_email_sent_to",
      "guest_invitations.rsvp_confirmation_email_provider_id",
      "guest_invitations.rsvp_confirmation_email_sent_at",
      "guest_invitations.rsvp_confirmation_email_sent_to",
      "guest_invitations.rsvp_reminder_email_provider_id",
      "guest_invitations.rsvp_reminder_email_sent_at",
      "guest_invitations.rsvp_reminder_email_sent_to",
    ]);
  });

  it("no plaintext token is stored anywhere: token columns are hashes or timestamps only", async () => {
    const rows = await sql<{ column_name: string }>(
      `select table_name || '.' || column_name as column_name from information_schema.columns
       where table_schema = 'public' and (column_name ilike '%token%' or column_name ilike '%link%'
                                          or column_name ilike '%url%' or column_name ilike '%secret%')
       order by 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      // LB-17: a worker's lease id (a random uuid, never a capability), not
      // readable by clients.
      "automatic_rsvp_reminders.claim_token",
      "guest_invitations.token_hash",
      "guest_invitations.token_issued_at",
      "membership_invites.token_hash",
    ]);
    const [lease] = await sql<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'automatic_rsvp_reminders' and column_name = 'claim_token'`,
    );
    expect(lease?.data_type).toBe("uuid");
  });

  it("only service_role can execute record_guest_invitation_email (ADR-004)", async () => {
    const rows = await sql<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, p.oid, 'execute') as can
       from pg_proc p
       cross join (values ('anon'), ('authenticated'), ('service_role')) as r (role)
       where p.oid = 'public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid)'::regprocedure
       order by r.role`,
    );
    expect(rows).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ]);
    // No PUBLIC grant either.
    const publicGrant = await sql(
      `select 1 from pg_proc p, aclexplode(p.proacl) a
       where p.oid = 'public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid)'::regprocedure
         and a.grantee = 0`,
    );
    expect(publicGrant).toEqual([]);
  });

  it("only service_role can execute the RSVP confirmation and reminder functions (ADR-005, ADR-007)", async () => {
    for (const signature of [
      "public.get_rsvp_confirmation_email_context(text)",
      "public.record_rsvp_confirmation_email(uuid, uuid, text, text, text)",
      "public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid)",
    ]) {
      const rows = await sql<{ role: string; can: boolean }>(
        `select r.role, has_function_privilege(r.role, $1::regprocedure, 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) as r (role) order by r.role`,
        [signature],
      );
      expect(rows, signature).toEqual([
        { role: "anon", can: false },
        { role: "authenticated", can: false },
        { role: "service_role", can: true },
      ]);
    }
  });

  it("guest_invitations: clients read and write the contact email, never the hash or the send metadata", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'guest_invitations'
         and grantee in ('anon', 'authenticated')
       order by grantee, privilege_type, column_name`,
    );
    const columns = (privilege: string) =>
      rows.filter((r) => r.grantee === "authenticated" && r.privilege_type === privilege).map((r) => r.column_name);
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(columns("SELECT")).not.toContain("token_hash");
    expect(columns("SELECT")).toEqual(
      expect.arrayContaining([
        "contact_email",
        "invitation_email_sent_at",
        "invitation_email_sent_to",
        "rsvp_confirmation_email_sent_at",
        "rsvp_confirmation_email_sent_to",
        "rsvp_reminder_email_sent_at",
        "rsvp_reminder_email_sent_to",
      ]),
    );
    // LB-13: parties are created only through create_guest_invitation (party + envelope).
    expect(columns("INSERT")).toEqual([]);
    // LB-13: rotation only through rotate_guest_invitation_link (hash + envelope).
    // LB-15: revocation only through revoke_guest_invitation_link (revocation + history).
    expect(columns("UPDATE")).toEqual(["contact_email", "label"]);
  });
});

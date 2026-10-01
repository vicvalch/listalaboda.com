import { describe, expect, it } from "vitest";

import { sql } from "./support";

// Catalog checks complement, never replace, the behavioral RLS tests: they
// guard properties that are easy to regress silently in a later migration.

const TABLES = ["weddings", "wedding_memberships", "membership_invites"];

describe("schema guarantees", () => {
  it("RLS is enabled on every LB-03 table", async () => {
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

  it("anon holds no privileges on any LB-03 table", async () => {
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

  it("authenticated has no INSERT on weddings or memberships", async () => {
    const rows = await sql<{ table_name: string }>(
      `select table_name from information_schema.column_privileges
       where grantee = 'authenticated' and privilege_type = 'INSERT'
         and table_schema = 'public' and table_name = any($1)
       group by table_name`,
      [TABLES],
    );
    expect(rows).toEqual([{ table_name: "membership_invites" }]);
  });

  it("every LB-03 function pins search_path and is not executable by anon/public", async () => {
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
              and p.proname in ('create_wedding', 'accept_membership_invite'))
       order by 1`,
    );

    expect(rows.map((r) => r.name)).toEqual([
      "private.enforce_wedding_has_owner",
      "private.guard_membership_invite_state",
      "private.has_wedding_role",
      "private.is_wedding_member",
      "private.set_updated_at",
      "public.accept_membership_invite",
      "public.create_wedding",
    ]);
    for (const fn of rows) {
      expect(fn.config, fn.name).toEqual(['search_path=""']);
      expect(fn.anon_exec, fn.name).toBe(false);
      expect(fn.public_exec, fn.name).toBe(false);
    }

    const callable = rows.filter((r) => r.authenticated_exec).map((r) => r.name);
    expect(callable).toEqual([
      "private.has_wedding_role",
      "private.is_wedding_member",
      "public.accept_membership_invite",
      "public.create_wedding",
    ]);
  });

  it("no function takes a caller-supplied user id", async () => {
    const rows = await sql<{ name: string; args: string }>(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p
       where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
         and p.proname in ('create_wedding', 'accept_membership_invite',
                           'is_wedding_member', 'has_wedding_role')
       order by 1`,
    );
    expect(rows).toEqual([
      { name: "accept_membership_invite", args: "invite_token_hash text" },
      { name: "create_wedding", args: "wedding_name text, wedding_date date" },
      { name: "has_wedding_role", args: "target_wedding_id uuid, allowed_roles wedding_role[]" },
      { name: "is_wedding_member", args: "target_wedding_id uuid" },
    ]);
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
    ]);
  });
});

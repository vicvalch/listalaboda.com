-- LB-21: the wedding vendor engagement foundation (ADR-014; ADR-001 §2, §7).
--
-- One table, public.wedding_vendors: a vendor ENGAGEMENT of one wedding (the
-- florist this couple is considering, the photographer they booked). There is
-- no global vendor table, planner directory or organization ownership: the
-- vendor's identity and contact fields are copied into the engagement, and a
-- future directory links to it additively (ADR-014 §4).
--
-- Vendor data is PRIVATE organizer data: any member (owner or collaborator)
-- manages it under member RLS; anon has no privileges at all, and nothing here
-- is reachable from public, RSVP, guest-capability or email functions. No
-- SECURITY DEFINER function, no service role, no trigger beyond updated_at.
--
-- Invariants enforced here, not in the app:
--   * plain-text name (1–120), contact name (1–120), custom category (1–60)
--     and notes (≤ 4000, multiline): trimmed, no control characters;
--   * a custom category exists exactly when the category is `other`;
--   * status is a closed enum with no transition rules;
--   * money is integer minor units (0 – 99 999 999 999 999, below JS's safe
--     integer range); a currency (CRC or USD only) exists exactly when at
--     least one amount does;
--   * email, phone and Instagram handle are conservative stored forms (no
--     URLs, no arbitrary schemes).
--
-- Payments, deposits, due dates, documents, checklist links and activity
-- events are out of scope (LB-22+). Deleting a vendor is a hard delete;
-- `discarded` is a business outcome, not a deletion.

create type public.wedding_vendor_category as enum (
  'venue',
  'catering',
  'photography',
  'video',
  'music',
  'flowers_decor',
  'cake_desserts',
  'beauty',
  'attire',
  'officiant',
  'stationery',
  'transport',
  'lodging',
  'rentals',
  'planning',
  'other'
);

-- No state machine: any status may change to any other.
create type public.wedding_vendor_status as enum (
  'considering',
  'quoted',
  'selected',
  'booked',
  'discarded'
);

create table public.wedding_vendors (
  id uuid primary key default gen_random_uuid(),
  -- Tenancy boundary. Deleting a wedding deletes its vendor engagements.
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- "Floristería Las Gardenias". Not unique: two engagements may share a name.
  name text not null,
  category public.wedding_vendor_category not null,
  -- Only for category `other` ("Seguridad"), and then required.
  custom_category text,
  status public.wedding_vendor_status not null default 'considering',
  -- The one primary contact person.
  contact_name text,
  -- Informational only: never an email recipient of this product.
  email text,
  phone text,
  -- Stored WITHOUT "@"; the app builds the profile URL from it.
  instagram_handle text,
  -- CRC or USD, and only when at least one amount exists.
  currency text,
  -- Integer minor units (céntimos / cents). Null = not entered; 0 is valid.
  quoted_amount_minor bigint,
  contracted_amount_minor bigint,
  notes text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint wedding_vendors_name_valid check (
    char_length(name) between 1 and 120
    and name !~ '^[[:space:]]|[[:space:]]$'
    and name !~ '[[:cntrl:]]'
  ),
  constraint wedding_vendors_custom_category_valid check (
    custom_category is null
    or (
      char_length(custom_category) between 1 and 60
      and custom_category !~ '^[[:space:]]|[[:space:]]$'
      and custom_category !~ '[[:cntrl:]]'
    )
  ),
  -- A custom category exactly when the category is `other`.
  constraint wedding_vendors_custom_category_iff_other check (
    (category = 'other') = (custom_category is not null)
  ),
  constraint wedding_vendors_contact_name_valid check (
    contact_name is null
    or (
      char_length(contact_name) between 1 and 120
      and contact_name !~ '^[[:space:]]|[[:space:]]$'
      and contact_name !~ '[[:cntrl:]]'
    )
  ),
  -- Same stored form as guest_invitations.contact_email (LB-11): plain ASCII,
  -- lowercase domain, local part as typed.
  constraint wedding_vendors_email_valid check (
    email is null
    or (
      char_length(email) <= 254
      and char_length(split_part(email, '@', 1)) <= 64
      and email ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    )
  ),
  -- Kept as typed (no E.164 normalization): an optional "+", an optional
  -- opening parenthesis, digits, spaces and ( ) . - separators, ending in a digit.
  constraint wedding_vendors_phone_valid check (
    phone is null
    or (
      char_length(phone) between 4 and 40
      and phone ~ '^\+?\(?[0-9][0-9 ().-]*[0-9]$'
    )
  ),
  constraint wedding_vendors_instagram_handle_valid check (
    instagram_handle is null
    or instagram_handle ~ '^[A-Za-z0-9._]{1,30}$'
  ),
  -- LB-21 supports exactly CRC and USD; more currencies are an additive change.
  constraint wedding_vendors_currency_valid check (
    currency is null or currency in ('CRC', 'USD')
  ),
  constraint wedding_vendors_quoted_amount_range check (
    quoted_amount_minor is null
    or quoted_amount_minor between 0 and 99999999999999
  ),
  constraint wedding_vendors_contracted_amount_range check (
    contracted_amount_minor is null
    or contracted_amount_minor between 0 and 99999999999999
  ),
  -- A currency exactly when at least one amount exists.
  constraint wedding_vendors_currency_iff_amount check (
    (currency is null) = (quoted_amount_minor is null and contracted_amount_minor is null)
  ),
  -- Trimmed, never blank (blank = null), ≤ 4000 characters; line feeds,
  -- carriage returns and tabs are the only control characters allowed.
  constraint wedding_vendors_notes_valid check (
    notes is null
    or (
      char_length(notes) between 1 and 4000
      and notes !~ '^[[:space:]]|[[:space:]]$'
      and translate(notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  ),
  -- Target of future same-wedding foreign keys (LB-22 payments, LB-23
  -- timeline): (wedding_vendor_id, wedding_id) → (id, wedding_id).
  constraint wedding_vendors_id_wedding_key unique (id, wedding_id)
);

comment on table public.wedding_vendors is
  'A wedding''s vendor engagements. Private organizer data; authority from wedding_memberships only. ADR-014.';
comment on column public.wedding_vendors.email is
  'Informational vendor contact address. Never used to send email.';
comment on column public.wedding_vendors.quoted_amount_minor is
  'Quote in integer minor units of currency (0–99 999 999 999 999). Null = not entered.';
comment on column public.wedding_vendors.contracted_amount_minor is
  'Contracted amount in integer minor units of currency. Null = not entered. Payments are LB-22.';
comment on column public.wedding_vendors.created_by is
  'Provenance only; never used for authorization.';

-- The list reads one wedding's vendors (ordered by created_at, id for a
-- stable base order; grouping and sorting happen in memory); also serves the
-- wedding_id FK cascade.
create index wedding_vendors_wedding_created_idx
  on public.wedding_vendors (wedding_id, created_at);

alter table public.wedding_vendors enable row level security;
revoke all on table public.wedding_vendors from anon, authenticated;

create trigger wedding_vendors_set_updated_at
  before update on public.wedding_vendors
  for each row execute function private.set_updated_at();

-- -------------------------------------------- organizer privileges + RLS
--
-- Any member of the wedding (owner or collaborator), identically. Ids, the
-- wedding, provenance and timestamps are not client-writable; rows never move
-- between weddings.

grant select on table public.wedding_vendors to authenticated;
grant insert (
  wedding_id, name, category, custom_category, status, contact_name, email, phone,
  instagram_handle, currency, quoted_amount_minor, contracted_amount_minor, notes
) on table public.wedding_vendors to authenticated;
grant update (
  name, category, custom_category, status, contact_name, email, phone,
  instagram_handle, currency, quoted_amount_minor, contracted_amount_minor, notes
) on table public.wedding_vendors to authenticated;
grant delete on table public.wedding_vendors to authenticated;

create policy wedding_vendors_select_member
  on public.wedding_vendors for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy wedding_vendors_insert_member
  on public.wedding_vendors for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy wedding_vendors_update_member
  on public.wedding_vendors for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy wedding_vendors_delete_member
  on public.wedding_vendors for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

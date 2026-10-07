-- LB-18.4 (part 1 of 2): the closed reason recipient_undeliverable (ADR-010
-- §7, §8; ADR-011 §10).
--
-- Only the enum value is added here. Postgres refuses to USE a value added by
-- ALTER TYPE ... ADD VALUE in the transaction that added it (the CHECK
-- constraint casts its literals when it is created), so the CHECK and the
-- eligibility functions that use it are changed in the next migration
-- (20261016120100_lb_automatic_reminder_recipient_suppression).
--
-- A pre-provider eligibility reason (state skipped, attempt_count = 0 only):
-- the party's CURRENT contact email is locally known as undeliverable in its
-- wedding (a suppressed, bounced or complained delivery to the same address).
-- Nothing uses it until the next migration; no row changes here.

alter type public.automatic_rsvp_reminder_outcome_reason
  add value 'recipient_undeliverable' after 'out_of_window';

comment on type public.automatic_rsvp_reminder_outcome_reason is
  'LB-17 (ADR-010 §8), LB-18.4: closed explanation for skipped, failed and unknown occurrences. Never free text.';

-- LB-20: the visual seating planner's layout model (ADR-013).
--
-- The planner is a progressive enhancement over the LB-19 seating domain
-- (ADR-012), which stays authoritative: tables, capacity and one-table-per-
-- guest assignments are unchanged. This migration only adds presentation
-- state to public.seating_tables:
--
--   * shape     — 'round' | 'rectangle' (closed enum). Visual only: it never
--                 changes capacity, assignments, ordering or position.
--   * layout_x,
--     layout_y  — the table's CENTER on the planner board, in logical integer
--                 units. Both null = "not placed yet" (the client derives a
--                 deterministic slot; opening the planner never writes).
--
-- The database range (0–10000) is deliberately loose: the client board's
-- width (1200 logical units) and grid (20 units) are presentation choices,
-- not domain invariants, and are not enforced here. Overlap is allowed. There
-- are no seats/chairs, sizes, rotation, rooms or floor-plan entities, and no
-- layout triggers: the existing capacity and sort_order triggers are
-- untouched. Concurrent position edits are last-write-wins.
--
-- Access is unchanged: the existing member RLS policies cover the new
-- columns; the column grants are widened narrowly (INSERT shape; UPDATE
-- shape, layout_x, layout_y). anon still has no privileges.

create type public.seating_table_shape as enum ('round', 'rectangle');

alter table public.seating_tables
  add column shape public.seating_table_shape not null default 'round',
  add column layout_x integer,
  add column layout_y integer,
  -- A table is either placed (both coordinates) or not (neither).
  add constraint seating_tables_layout_pair check ((layout_x is null) = (layout_y is null)),
  add constraint seating_tables_layout_range check (
    (layout_x is null or layout_x between 0 and 10000)
    and (layout_y is null or layout_y between 0 and 10000)
  );

comment on column public.seating_tables.shape is
  'Visual shape on the seating planner. Never affects capacity or assignments.';
comment on column public.seating_tables.layout_x is
  'Planner board X of the table center, logical units (0–10000). Null with layout_y = not placed yet.';
comment on column public.seating_tables.layout_y is
  'Planner board Y of the table center, logical units (0–10000). Null with layout_x = not placed yet.';

grant insert (shape) on table public.seating_tables to authenticated;
grant update (shape, layout_x, layout_y) on table public.seating_tables to authenticated;

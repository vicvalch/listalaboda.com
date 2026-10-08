"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { memo, useCallback, useMemo, useOptimistic, useRef, useState, useTransition } from "react";

import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { buildSeatingPlan, type SeatingGuest, type SeatingTablePlan } from "@/lib/seating/plan";
import {
  BOARD_WIDTH,
  GRID_SIZE,
  applyPlannerAction,
  boardHeight,
  boardScale,
  chairMarkers,
  deriveTablePositions,
  droppedTablePosition,
  guestDropOutcome,
  isGuestDraggable,
  tableShapeSize,
  visibleGuestCount,
  type DropTarget,
  type PlacedTable,
  type PlannerState,
} from "@/lib/seating/planner";

import {
  moveGuestAction,
  positionTableAction,
  seatGuestAction,
  unseatGuestAction,
  type SeatingActionState,
} from "./actions";
import { PlannerInspector, type PlannerSelection } from "./PlannerInspector";

const copy = getMessages().seating;
const planner = copy.planner;

// Stable drag/drop metadata: the KIND is explicit, never inferred from ids.
type DragData =
  | Readonly<{ type: "table"; tableId: string }>
  | Readonly<{ type: "guest"; guestId: string; sourceTableId: string | null }>;
type DropData = Readonly<{ type: "rail" }> | Readonly<{ type: "table"; tableId: string }>;

const RAIL_ID = "rail";
const tableDragId = (id: string) => `table-drag:${id}`;
const tableDropId = (id: string) => `table-drop:${id}`;
const guestDragId = (id: string) => `guest:${id}`;

type Message = Readonly<{ text: string; tone: "info" | "error"; key: number }>;

/** dnd-kit's own announcer is silenced: the planner has ONE live region (below). */
const silent: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

function dragData(value: unknown): DragData | null {
  return value && typeof value === "object" && "type" in value ? (value as DragData) : null;
}

function dropData(value: unknown): DropData | null {
  return value && typeof value === "object" && "type" in value ? (value as DropData) : null;
}

/** Calls an LB-19 action from the planner; an exception never escapes to the error boundary. */
async function runAction(
  action: (prev: SeatingActionState, formData: FormData) => Promise<SeatingActionState>,
  fields: Readonly<Record<string, string>>,
): Promise<SeatingActionState> {
  const formData = new FormData();
  for (const [name, value] of Object.entries(fields)) formData.set(name, value);
  try {
    return await action(null, formData);
  } catch {
    return null;
  }
}

function guestPlace(guest: SeatingGuest, tableName: string | null): string {
  const place = tableName ?? planner.unseatedPlace;
  if (guest.rsvpState === "attending") return interpolate(planner.guestLabel, { guest: guest.name, place });
  const status = guest.rsvpState === "pending" ? planner.statusPending : planner.statusDeclined;
  return interpolate(planner.guestLabelStatus, { guest: guest.name, place, status });
}

/**
 * The visual seating planner (LB-20, ADR-013): a progressive enhancement of
 * the LB-19 list over the same server data and actions.
 *
 *   * Guests: dropping maps to exactly one LB-19 action — rail → table
 *     `seatGuestAction`, table → table `moveGuestAction`, table → rail
 *     `unseatGuestAction` — shown optimistically and reverted to the server
 *     state on any failure. Known-full tables and declined guests are refused
 *     before any request; the database still decides every race.
 *   * Tables: moved by a dedicated handle; the position is computed once, on
 *     drop (screen delta ÷ scale, snapped, clamped) and saved with ONE
 *     `positionTableAction` call. Nothing is written while dragging, and a
 *     failed save snaps the table back.
 *   * The inspector's forms do everything without dragging.
 */
export function SeatingPlanner({ weddingId, data }: { weddingId: string; data: PlannerState }) {
  const [state, applyOptimistic] = useOptimistic(data, applyPlannerAction);
  const [, startTransition] = useTransition();
  const plan = useMemo(() => buildSeatingPlan(state.tables, state.parties), [state]);
  const placed = useMemo(() => deriveTablePositions(plan.tables), [plan.tables]);
  const placedById = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const height = boardHeight(placed);

  const guestsById = useMemo(() => {
    const map = new Map<string, SeatingGuest>();
    for (const table of plan.tables) for (const guest of table.guests) map.set(guest.id, guest);
    for (const groups of [plan.unassigned.attending, plan.unassigned.pending, plan.declined]) {
      for (const group of groups) for (const guest of group.guests) map.set(guest.id, guest);
    }
    return map;
  }, [plan]);
  const tablesById = useMemo(() => new Map(plan.tables.map((t) => [t.id, t])), [plan.tables]);

  const [selection, setSelection] = useState<PlannerSelection>(null);
  const [active, setActive] = useState<DragData | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const targetOrder = useMemo(() => [RAIL_ID, ...plan.tables.map((t) => tableDropId(t.id))], [plan.tables]);

  const say = useCallback((text: string, tone: Message["tone"] = "info") => {
    setMessage((previous) => ({ text, tone, key: (previous?.key ?? 0) + 1 }));
  }, []);

  const currentScale = useCallback(() => boardScale(boardRef.current?.getBoundingClientRect().width ?? 0), []);

  // Keyboard: a table moves one 20-unit grid step per arrow key; a guest
  // jumps between drop targets ("Sin mesa", then the tables in order).
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event, { currentCoordinates, context }) => {
      const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.code];
      if (!step) return undefined;
      event.preventDefault();
      const data = dragData(context.active?.data.current);
      if (!data) return undefined;

      if (data.type === "table") {
        const px = GRID_SIZE * currentScale();
        return { x: currentCoordinates.x + step[0] * px, y: currentCoordinates.y + step[1] * px };
      }

      const ids = targetOrder;
      const current = context.over ? ids.indexOf(String(context.over.id)) : -1;
      const forward = step[0] + step[1] > 0;
      const next = current === -1 ? (forward ? 0 : ids.length - 1) : (current + (forward ? 1 : -1) + ids.length) % ids.length;
      const rect = context.droppableRects.get(ids[next] ?? "");
      const collision = context.collisionRect;
      if (!rect || !collision) return undefined;
      return {
        x: rect.left + rect.width / 2 - collision.width / 2,
        y: rect.top + rect.height / 2 - collision.height / 2,
      };
    },
    [currentScale, targetOrder],
  );

  const sensors = useSensors(
    // A small distance, so a click selects instead of starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
      coordinateGetter,
    }),
  );

  // Tables are never drop targets of a table drag; a guest drag uses the
  // pointer when there is one, the overlay's rectangle otherwise (keyboard).
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (dragData(args.active.data.current)?.type !== "guest") return [];
    return args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
  }, []);

  function targetOf(over: DragEndEvent["over"]): DropTarget | null {
    const data = dropData(over?.data.current);
    if (!data) return null;
    if (data.type === "rail") return { kind: "rail" };
    const table = tablesById.get(data.tableId);
    return table ? { kind: "table", tableId: table.id, isFull: table.isFull } : null;
  }

  function onDragStart(event: DragStartEvent) {
    const data = dragData(event.active.data.current);
    setActive(data);
    if (data?.type === "guest") {
      const guest = guestsById.get(data.guestId);
      if (guest) say(interpolate(planner.announce.pickUpGuest, { guest: guest.name }));
    } else if (data?.type === "table") {
      const table = tablesById.get(data.tableId);
      if (table) say(interpolate(planner.announce.pickUpTable, { table: table.name }));
    }
  }

  function onDragOver(event: DragOverEvent) {
    // Only keyboard users need to hear where a guest is; pointer users see it.
    if (event.activatorEvent instanceof KeyboardEvent && dragData(event.active.data.current)?.type === "guest") {
      const target = targetOf(event.over);
      if (target?.kind === "rail") say(planner.rail.title);
      else if (target?.kind === "table") {
        const table = tablesById.get(target.tableId);
        if (table) say(table.isFull ? interpolate(copy.seat.fullOption, { table: table.name }) : table.name);
      }
    }
  }

  function onDragCancel() {
    setActive(null);
    say(planner.announce.cancelled);
  }

  function dropTable(tableId: string, delta: { x: number; y: number }) {
    const table = tablesById.get(tableId);
    const place = placedById.get(tableId);
    if (!table || !place) return;
    const position = droppedTablePosition(place.position, delta, currentScale(), place.footprint);
    if (position.x === place.position.x && position.y === place.position.y) {
      say(planner.announce.noChange);
      return;
    }
    startTransition(async () => {
      applyOptimistic({ type: "position", tableId, position });
      const result = await runAction(positionTableAction, {
        weddingId,
        tableId,
        x: String(position.x),
        y: String(position.y),
      });
      // On failure the optimistic position is dropped: back to the server's.
      if (result?.ok) say(interpolate(planner.announce.tableMoved, { table: table.name }));
      else say(planner.positionFailed, "error");
    });
  }

  function dropGuest(guestId: string, over: DragEndEvent["over"]) {
    const guest = guestsById.get(guestId);
    const target = targetOf(over);
    if (!guest || !target) {
      say(planner.announce.cancelled);
      return;
    }
    const outcome = guestDropOutcome(guest, target);
    const destination = target.kind === "table" ? tablesById.get(target.tableId) : undefined;

    switch (outcome.kind) {
      case "noop":
        say(planner.announce.noChange);
        return;
      case "refused":
        say(
          outcome.reason === "table_full"
            ? `${planner.tableFull}. ${interpolate(planner.announce.full, { guest: guest.name, table: destination?.name ?? "" })}`
            : interpolate(planner.announce.declined, { guest: guest.name }),
          "error",
        );
        return;
    }

    const action = outcome.kind === "seat" ? seatGuestAction : outcome.kind === "move" ? moveGuestAction : unseatGuestAction;
    const tableId = outcome.kind === "unseat" ? null : outcome.tableId;
    startTransition(async () => {
      applyOptimistic({ type: "assign", guestId, tableId });
      const result = await runAction(action, { weddingId, guestId, tableId: tableId ?? "" });
      if (result?.ok) {
        say(
          tableId
            ? interpolate(planner.announce.seated, { guest: guest.name, table: destination?.name ?? "" })
            : interpolate(planner.announce.unseated, { guest: guest.name }),
        );
      } else if (result?.reason === "table_full") {
        // Lost the race for the last seat: the database decided. The
        // optimistic move is dropped and the action already refreshed the data.
        say(
          `${planner.tableFull}. ${interpolate(planner.announce.full, { guest: guest.name, table: destination?.name ?? "" })}`,
          "error",
        );
      } else {
        say(result?.formError ?? planner.guestFailed, "error");
      }
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const data = dragData(event.active.data.current);
    setActive(null);
    if (data?.type === "table") dropTable(data.tableId, event.delta);
    else if (data?.type === "guest") dropGuest(data.guestId, event.over);
  }

  const selectTable = useCallback((id: string) => setSelection({ kind: "table", id }), []);
  const selectGuest = useCallback((id: string) => setSelection({ kind: "guest", id }), []);

  const activeGuest = active?.type === "guest" ? (guestsById.get(active.guestId) ?? null) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{
        announcements: silent,
        screenReaderInstructions: { draggable: planner.instructions },
      }}
    >
      <p
        role="status"
        aria-live="polite"
        data-testid="planner-message"
        className={`min-h-6 text-sm font-medium ${message?.tone === "error" ? "text-danger" : "text-muted"}`}
      >
        {message ? <span key={message.key}>{message.text}</span> : null}
      </p>

      <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] xl:grid-cols-[12rem_minmax(0,1fr)_16rem]">
        <Rail plan={plan} activeGuest={activeGuest} selection={selection} onSelectGuest={selectGuest} />

        <div className="min-w-0 space-y-2">
          <p className="text-muted text-sm">{planner.boardHint}</p>
          <div
            ref={boardRef}
            role="region"
            aria-label={planner.boardLabel}
            data-testid="planner-board"
            data-board-height={height}
            className="relative w-full overflow-hidden rounded-2xl border border-border bg-surface"
            style={{
              aspectRatio: `${BOARD_WIDTH} / ${height}`,
              backgroundImage:
                "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
              backgroundSize: `calc(100% / ${BOARD_WIDTH / 100}) calc(100% / ${height / 100})`,
            }}
          >
            {plan.tables.map((table) => {
              const place = placedById.get(table.id);
              if (!place) return null;
              return (
                <TableNode
                  key={table.id}
                  table={table}
                  place={place}
                  boardHeight={height}
                  dropState={dropStateFor(activeGuest, table)}
                  selectedTable={selection?.kind === "table" && selection.id === table.id}
                  selectedGuestId={selection?.kind === "guest" ? selection.id : null}
                  onSelectTable={selectTable}
                  onSelectGuest={selectGuest}
                />
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-2 xl:col-span-1">
          <PlannerInspector
            weddingId={weddingId}
            plan={plan}
            selection={selection}
            onClose={() => setSelection(null)}
          />
        </div>
      </div>

      {/* The dragged guest follows the pointer above everything; nothing is written while it moves. */}
      <DragOverlay dropAnimation={null}>
        {activeGuest ? (
          <span className="bg-accent text-accent-foreground inline-block max-w-48 truncate rounded-full px-3 py-1 text-xs font-semibold shadow-lg">
            {activeGuest.name}
          </span>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

type DropState = "idle" | "allowed" | "refused";

function dropStateFor(guest: SeatingGuest | null, table: SeatingTablePlan): DropState {
  if (!guest) return "idle";
  const outcome = guestDropOutcome(guest, { kind: "table", tableId: table.id, isFull: table.isFull });
  if (outcome.kind === "refused") return "refused";
  return outcome.kind === "noop" ? "idle" : "allowed";
}

// --------------------------------------------------------------------- rail

function Rail({
  plan,
  activeGuest,
  selection,
  onSelectGuest,
}: {
  plan: ReturnType<typeof buildSeatingPlan>;
  activeGuest: SeatingGuest | null;
  selection: PlannerSelection;
  onSelectGuest: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: RAIL_ID, data: { type: "rail" } satisfies DropData });
  const { attending, pending } = plan.unassigned;
  const canDropHere = activeGuest?.tableId != null;
  const selectedGuestId = selection?.kind === "guest" ? selection.id : null;

  return (
    <aside
      ref={setNodeRef}
      aria-labelledby="planner-rail-title"
      data-testid="planner-rail"
      className={`space-y-4 rounded-2xl border bg-surface p-3 lg:self-start ${
        isOver && canDropHere ? "border-accent ring-2 ring-accent" : "border-border"
      }`}
    >
      <h2 id="planner-rail-title" className="text-lg font-semibold">
        {planner.rail.title}
      </h2>
      {canDropHere ? <p className="text-muted text-xs">{planner.rail.dropHint}</p> : null}
      {attending.length === 0 && pending.length === 0 ? (
        <p className="text-muted text-sm">{planner.rail.empty}</p>
      ) : null}
      {(
        [
          ["attending", planner.rail.attending, attending],
          ["pending", planner.rail.pending, pending],
        ] as const
      ).map(([key, title, groups]) =>
        groups.length > 0 ? (
          <section key={key} aria-label={title} className="space-y-2">
            <h3 className="text-muted text-xs font-semibold uppercase tracking-wide">{title}</h3>
            <ul className="space-y-2">
              {groups.map((group) => (
                <li key={group.partyId}>
                  <ul aria-label={interpolate(copy.party, { party: group.partyLabel })} className="flex flex-wrap gap-1">
                    {group.guests.map((guest) => (
                      <li key={guest.id}>
                        <GuestPill
                          guest={guest}
                          tableName={null}
                          variant="rail"
                          selected={guest.id === selectedGuestId}
                          onSelect={onSelectGuest}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {plan.declined.length > 0 ? (
        <details className="space-y-2">
          <summary className="text-muted cursor-pointer text-xs font-semibold uppercase tracking-wide">
            {planner.rail.declined}
          </summary>
          <ul className="mt-2 flex flex-wrap gap-1">
            {plan.declined.flatMap((group) =>
              group.guests.map((guest) => (
                <li key={guest.id}>
                  <GuestPill
                    guest={guest}
                    tableName={null}
                    variant="rail"
                    selected={guest.id === selectedGuestId}
                    onSelect={onSelectGuest}
                  />
                </li>
              )),
            )}
          </ul>
        </details>
      ) : null}
    </aside>
  );
}

// --------------------------------------------------------------- guest pill

const GuestPill = memo(function GuestPill({
  guest,
  tableName,
  variant,
  selected,
  onSelect,
}: {
  guest: SeatingGuest;
  tableName: string | null;
  variant: "rail" | "table";
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const draggable = isGuestDraggable(guest);
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: guestDragId(guest.id),
    data: { type: "guest", guestId: guest.id, sourceTableId: guest.tableId } satisfies DragData,
    disabled: !draggable,
    attributes: { roleDescription: planner.roleDescription },
  });
  const tone =
    guest.rsvpState === "declined"
      ? "border-danger/50 bg-danger-soft text-danger"
      : guest.rsvpState === "pending"
        ? "border-dashed border-border bg-surface"
        : "border-border bg-accent-soft";
  // No RSVP badge on the pill: the rail's sections are titled by answer, and
  // a table's pill shows it by its style; the accessible name always says it.
  const size = variant === "rail" ? "px-2 py-1 text-xs" : "px-1.5 py-0.5 text-[11px] leading-tight";

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      onClick={() => onSelect(guest.id)}
      aria-label={guestPlace(guest, tableName)}
      title={interpolate(copy.party, { party: guest.partyLabel })}
      data-testid="planner-guest"
      data-guest-name={guest.name}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border font-medium ${tone} ${size} ${
        draggable ? "cursor-grab touch-none" : "cursor-default"
      } ${selected ? "ring-2 ring-accent" : ""} ${isDragging ? "opacity-40" : ""}`}
    >
      <span className="truncate">{guest.name}</span>
    </button>
  );
});

// --------------------------------------------------------------- table node

const TableNode = memo(function TableNode({
  table,
  place,
  boardHeight: height,
  dropState,
  selectedTable,
  selectedGuestId,
  onSelectTable,
  onSelectGuest,
}: {
  table: SeatingTablePlan;
  place: PlacedTable;
  boardHeight: number;
  dropState: DropState;
  selectedTable: boolean;
  selectedGuestId: string | null;
  onSelectTable: (id: string) => void;
  onSelectGuest: (id: string) => void;
}) {
  const {
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    isDragging,
  } = useDraggable({
    id: tableDragId(table.id),
    data: { type: "table", tableId: table.id } satisfies DragData,
    attributes: { roleDescription: planner.roleDescription },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: tableDropId(table.id),
    data: { type: "table", tableId: table.id } satisfies DropData,
  });
  // One element is both the dragged node (measured, translated) and the drop target.
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  const { footprint, position } = place;
  const occupancy = { assigned: formatNumber(table.assignedCount), capacity: formatNumber(table.capacity) };
  const conflicts = table.guests.filter((g) => g.rsvpState === "declined").length;
  const shown = table.guests.slice(0, visibleGuestCount(table.shape, table.capacity));
  const hidden = table.guests.length - shown.length;
  const ring =
    dropState === "refused" && isOver
      ? "ring-2 ring-danger"
      : dropState === "allowed" && isOver
        ? "ring-2 ring-accent"
        : selectedTable
          ? "ring-2 ring-accent/60"
          : "";

  return (
    <div
      ref={setRefs}
      role="group"
      // Not aria-disabled: on a group it would disable the handle, name and
      // guests inside for assistive technology. "llena" is in the name, the
      // keyboard drag announces it, and the drop is refused before any request.
      aria-label={interpolate(table.isFull ? planner.selectTableFull : planner.selectTable, {
        table: table.name,
        ...occupancy,
      })}
      data-full={table.isFull ? "true" : undefined}
      data-testid="planner-table"
      data-table-name={table.name}
      data-shape={table.shape}
      data-x={position.x}
      data-y={position.y}
      data-placed={place.derived ? "derived" : "stored"}
      data-drop={dropState}
      className={`absolute rounded-xl ${ring} ${isDragging ? "z-20 opacity-90" : "z-10"} ${
        dropState === "refused" ? "cursor-not-allowed" : ""
      }`}
      style={{
        left: `${((position.x - footprint.width / 2) / BOARD_WIDTH) * 100}%`,
        top: `${((position.y - footprint.height / 2) / height) * 100}%`,
        width: `${(footprint.width / BOARD_WIDTH) * 100}%`,
        height: `${(footprint.height / height) * 100}%`,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      <TableDrawing table={table} footprint={footprint} />
      {/* "safe" centering: if the content is taller than the table, it is cut at
          the bottom, never at the top, so the handle is always reachable. */}
      <div className="absolute inset-[8%] flex flex-col items-center justify-center-safe gap-0.5 overflow-hidden text-center">
        <div className="flex w-full items-center justify-center gap-0.5">
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => onSelectTable(table.id)}
            aria-label={interpolate(planner.moveTable, { table: table.name })}
            data-testid="planner-table-handle"
            className="text-muted hover:text-foreground shrink-0 cursor-grab touch-none rounded px-0.5 text-sm leading-none"
          >
            <span aria-hidden="true">⠿</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectTable(table.id)}
            title={table.name}
            className="min-w-0 truncate rounded bg-surface/80 px-1 text-xs font-semibold"
          >
            {table.name}
          </button>
        </div>
        <p className="flex flex-wrap items-center justify-center gap-1 text-[11px] leading-tight">
          <span data-testid="planner-table-occupancy" className="rounded bg-surface/80 px-1 font-semibold">
            {interpolate(copy.tables.occupancy, occupancy)}
          </span>
          {hidden > 0 ? (
            <span
              data-testid="planner-table-more"
              aria-label={interpolate(planner.moreLabel, { count: formatNumber(hidden) })}
              className="text-muted rounded bg-surface/80 px-1 font-semibold"
            >
              {interpolate(planner.more, { count: formatNumber(hidden) })}
            </span>
          ) : null}
          {table.isFull ? (
            <span data-testid="planner-table-full" className="bg-accent text-accent-foreground rounded-full px-1.5 font-semibold">
              {planner.full}
            </span>
          ) : null}
          {conflicts > 0 ? (
            <span data-testid="planner-table-conflicts" className="bg-danger-soft text-danger rounded-full px-1.5 font-semibold">
              {interpolate(conflicts === 1 ? planner.declinedCount : planner.declinedCountMany, {
                count: formatNumber(conflicts),
              })}
            </span>
          ) : null}
        </p>
        {table.guests.length > 0 ? (
          <ul className="flex max-w-full flex-col items-center gap-0.5">
            {shown.map((guest) => (
              <li key={guest.id} className="max-w-full">
                <GuestPill
                  guest={guest}
                  tableName={table.name}
                  variant="table"
                  selected={guest.id === selectedGuestId}
                  onSelect={onSelectGuest}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
});

/** The table and its decorative chairs. Chairs are positions only, never guests. */
function TableDrawing({ table, footprint }: { table: SeatingTablePlan; footprint: PlacedTable["footprint"] }) {
  const size = tableShapeSize(table.shape, table.capacity);
  const chairs = chairMarkers(table.shape, table.capacity);
  const fill = table.isFull ? "var(--accent-soft)" : "var(--background)";
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      viewBox={`${-footprint.width / 2} ${-footprint.height / 2} ${footprint.width} ${footprint.height}`}
    >
      {chairs.points.map((point, i) => (
        <circle
          key={i}
          cx={point.x}
          cy={point.y}
          r={chairs.radius}
          fill="var(--surface)"
          stroke="var(--muted)"
          strokeWidth={1.5}
        />
      ))}
      {table.shape === "rectangle" ? (
        <rect
          x={-size.width / 2}
          y={-size.height / 2}
          width={size.width}
          height={size.height}
          rx={10}
          fill={fill}
          stroke="var(--accent)"
          strokeWidth={2}
        />
      ) : (
        <circle r={size.width / 2} fill={fill} stroke="var(--accent)" strokeWidth={2} />
      )}
    </svg>
  );
}

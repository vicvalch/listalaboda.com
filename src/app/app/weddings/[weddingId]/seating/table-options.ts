import { getMessages, interpolate } from "@/lib/i18n";
import type { SeatingTablePlan } from "@/lib/seating/plan";

export type TableOption = Readonly<{ id: string; label: string; disabled: boolean }>;

/**
 * Destination tables for seat/move: known-full tables are listed but disabled
 * ("Mesa 1 (llena)"). Shared by the list (server) and the planner's
 * inspector (client); the database stays authoritative either way.
 */
export function seatingTableOptions(tables: readonly SeatingTablePlan[], excludeId: string | null): TableOption[] {
  const copy = getMessages().seating;
  return tables
    .filter((table) => table.id !== excludeId)
    .map((table) => ({
      id: table.id,
      label: table.isFull ? interpolate(copy.seat.fullOption, { table: table.name }) : table.name,
      disabled: table.isFull,
    }));
}

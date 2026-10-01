import {
  MAX_RELATIVE_DAYS,
  relativeDaysFromInput,
  relativeInputFromDays,
  type RelativeDirection,
} from "@/lib/checklist/timing";
import {
  isChecklistCategory,
  isChecklistStatus,
  type ChecklistCategory,
  type ChecklistItem,
  type ChecklistStatus,
  type ChecklistTiming,
} from "@/lib/checklist/types";
import { es } from "@/lib/i18n/messages/es";
import { isIsoCalendarDate } from "@/lib/weddings/validation";

/**
 * UX validation for checklist item forms. The database stays authoritative
 * (non-blank title, length caps, timing consistency, day range, enums); this
 * mirrors what gives the user a useful Spanish message before a round-trip.
 *
 * Users never type a signed offset: they pick a number of days and
 * "antes"/"después"/"el día de la boda", mapped to relative_days here.
 */

export const CHECKLIST_TITLE_MAX_LENGTH = 200;
export const CHECKLIST_DESCRIPTION_MAX_LENGTH = 2000;

export type ChecklistItemField =
  | "title"
  | "description"
  | "category"
  | "timingMode"
  | "dueDate"
  | "relativeAmount"
  | "relativeDirection";

export type ChecklistItemRawInput = Readonly<Record<ChecklistItemField, string>>;

export type ChecklistItemInput = Readonly<{
  title: string;
  description: string | null;
  category: ChecklistCategory | null;
  timing: ChecklistTiming;
}>;

export type ChecklistItemInputResult =
  | Readonly<{ ok: true; input: ChecklistItemInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<ChecklistItemField, string>> }>;

const DIRECTIONS: readonly RelativeDirection[] = ["before", "after", "on"];
const WHOLE_NUMBER = /^\d{1,4}$/;

function isDirection(value: string): value is RelativeDirection {
  return (DIRECTIONS as readonly string[]).includes(value);
}

export function parseChecklistItemInput(raw: ChecklistItemRawInput): ChecklistItemInputResult {
  const messages = es.checklist.validation;
  const fieldErrors: Partial<Record<ChecklistItemField, string>> = {};

  const title = raw.title.trim();
  if (!title) fieldErrors.title = messages.titleRequired;
  else if (title.length > CHECKLIST_TITLE_MAX_LENGTH) fieldErrors.title = messages.titleTooLong;

  const description = raw.description.trim();
  if (description.length > CHECKLIST_DESCRIPTION_MAX_LENGTH) {
    fieldErrors.description = messages.descriptionTooLong;
  }

  const categoryValue = raw.category.trim();
  let category: ChecklistCategory | null = null;
  if (categoryValue) {
    if (isChecklistCategory(categoryValue)) category = categoryValue;
    else fieldErrors.category = messages.categoryInvalid;
  }

  let timing: ChecklistTiming | null = null;
  switch (raw.timingMode || "none") {
    case "none":
      timing = { mode: "none" };
      break;
    case "absolute": {
      const dueDate = raw.dueDate.trim();
      if (isIsoCalendarDate(dueDate)) timing = { mode: "absolute", dueDate };
      else fieldErrors.dueDate = messages.dateInvalid;
      break;
    }
    case "relative_to_wedding": {
      const direction = raw.relativeDirection;
      if (!isDirection(direction)) {
        fieldErrors.relativeDirection = messages.directionInvalid;
        break;
      }
      if (direction === "on") {
        timing = { mode: "relative_to_wedding", relativeDays: 0 };
        break;
      }
      const amount = raw.relativeAmount.trim();
      const days = WHOLE_NUMBER.test(amount) ? Number(amount) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > MAX_RELATIVE_DAYS) {
        fieldErrors.relativeAmount = messages.daysInvalid;
        break;
      }
      timing = {
        mode: "relative_to_wedding",
        relativeDays: relativeDaysFromInput({ direction, days }),
      };
      break;
    }
    default:
      fieldErrors.timingMode = messages.timingInvalid;
  }

  if (Object.keys(fieldErrors).length > 0 || !timing) return { ok: false, fieldErrors };
  return { ok: true, input: { title, description: description || null, category, timing } };
}

/** A status sent by a status-change form; anything else is rejected. */
export function parseStatusInput(value: string): ChecklistStatus | null {
  return isChecklistStatus(value) ? value : null;
}

/** Empty form: no date, "before the wedding" preselected for convenience. */
export const EMPTY_ITEM_FORM_VALUES: ChecklistItemRawInput = {
  title: "",
  description: "",
  category: "",
  timingMode: "none",
  dueDate: "",
  relativeAmount: "",
  relativeDirection: "before",
};

/** An item's current values as edit-form fields (inverse of the parser). */
export function itemFormValues(item: ChecklistItem): ChecklistItemRawInput {
  const base = {
    ...EMPTY_ITEM_FORM_VALUES,
    title: item.title,
    description: item.description ?? "",
    category: item.category ?? "",
    timingMode: item.timing.mode,
  };
  switch (item.timing.mode) {
    case "none":
      return base;
    case "absolute":
      return { ...base, dueDate: item.timing.dueDate };
    case "relative_to_wedding": {
      const { direction, days } = relativeInputFromDays(item.timing.relativeDays);
      return {
        ...base,
        relativeDirection: direction,
        relativeAmount: direction === "on" ? "" : String(days),
      };
    }
  }
}

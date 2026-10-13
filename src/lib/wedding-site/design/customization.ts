import {
  CUSTOMIZABLE_FIELDS,
  getTheme,
  type Alignment,
  type ContentWidth,
  type CustomizableField,
  type Density,
  type HeadingScale,
  type HeroVariant,
  type SectionStyle,
  type SitePalette,
  type ThemeDefinition,
  type Typography,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";

/**
 * Safe wedding site customization (ADR-019, CP6): a wedding's choices among
 * the closed options its theme offers (`ThemeDefinition.options`). Nothing
 * here is free-form: every value is a key from a fixed vocabulary that the
 * renderer maps to its own markup and classes, never a color, CSS, class
 * name, font, URL or text.
 *
 * Stored as a versioned document (`wedding_site_designs.customization`)
 * holding ONLY overrides, never resolved values; a missing field means "the
 * theme's default". No overrides is stored as `{}`:
 *
 *   {
 *     "schemaVersion": 1,
 *     "palette":    { "kind": "preset", "key": "parchment" },
 *     "typography": { "pairing": "mixed", "headingScale": "regular" },
 *     "hero":       { "variant": "simple" },
 *     "layout":     { "width": "regular", "density": "regular",
 *                     "alignment": "start", "sectionStyle": "plain" }
 *   }
 *
 * Three layers check it: `parseCustomization` on write (strict: anything
 * unexpected refuses the whole document), the database CHECK
 * (`private.wedding_site_customization_is_valid`, the same rules) and
 * `readCustomization` before every render (lenient: a bad field falls back
 * to the theme's default, so a bad row can never break the public page).
 */

/** The customization document version this code reads and writes. */
export const CUSTOMIZATION_SCHEMA_VERSION = 1;

/**
 * Upper bound of a stored document, in bytes of its JSON text. The largest
 * valid version-1 document is about 300 bytes; the database refuses anything
 * over this, before looking inside (ADR-019 §10).
 */
export const MAX_CUSTOMIZATION_BYTES = 1024;

/** The stored document, version 1. Every group is optional; groups are never empty. */
export type WeddingSiteCustomizationV1 = Readonly<{
  schemaVersion: 1;
  palette?: Readonly<{ kind: "preset"; key: SitePalette }>;
  typography?: Readonly<{ pairing?: Typography; headingScale?: HeadingScale }>;
  hero?: Readonly<{ variant: HeroVariant }>;
  layout?: Readonly<{ width?: ContentWidth; density?: Density; alignment?: Alignment; sectionStyle?: SectionStyle }>;
}>;

/** What is stored: a version-1 document with at least one override, or `{}`. */
export type StoredCustomization = WeddingSiteCustomizationV1 | Readonly<Record<string, never>>;

/**
 * A wedding's overrides, one optional value per customizable field, already
 * checked against its theme: the in-memory form of a customization.
 */
export type SiteOverrides = Readonly<Partial<Pick<ThemeDefinition, CustomizableField>>>;

/** The groups of the document, reset one at a time. */
export const CUSTOMIZATION_GROUPS = ["palette", "typography", "hero", "layout"] as const;
export type CustomizationGroup = (typeof CUSTOMIZATION_GROUPS)[number];

/** Where each field lives in the document: its group and its key there. */
export const FIELD_LOCATION = {
  palette: { group: "palette", key: "key" },
  typography: { group: "typography", key: "pairing" },
  headingScale: { group: "typography", key: "headingScale" },
  hero: { group: "hero", key: "variant" },
  width: { group: "layout", key: "width" },
  density: { group: "layout", key: "density" },
  alignment: { group: "layout", key: "alignment" },
  sectionStyle: { group: "layout", key: "sectionStyle" },
} as const satisfies { [F in CustomizableField]: { group: CustomizationGroup; key: string } };

/** The fields of a group, in field order. */
export function groupFields(group: CustomizationGroup): CustomizableField[] {
  return CUSTOMIZABLE_FIELDS.filter((field) => FIELD_LOCATION[field].group === group);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Whether a value is one of the theme's options for a field (an exact string). */
export function isAllowedValue<F extends CustomizableField>(
  theme: ThemeDefinition,
  field: F,
  value: unknown,
): value is ThemeDefinition[F] {
  return typeof value === "string" && (theme.options[field] as readonly string[]).includes(value);
}

/**
 * Keeps only the overrides that the theme allows AND that differ from its
 * default (a choice equal to the default is not an override). The one
 * normalization rule: after parsing, after a theme change, before storing.
 */
export function normalizeOverrides(themeKey: WeddingSiteThemeKey, overrides: SiteOverrides): SiteOverrides {
  const theme = getTheme(themeKey);
  const result: Partial<Record<CustomizableField, string>> = {};
  for (const field of CUSTOMIZABLE_FIELDS) {
    const value = overrides[field];
    if (value !== undefined && isAllowedValue(theme, field, value) && value !== theme[field]) result[field] = value;
  }
  return result as SiteOverrides;
}

type Fields = Partial<Record<CustomizableField, unknown>>;

/**
 * Reads a document's groups into raw per-field values, checking its shape.
 * `strict` refuses anything unexpected; otherwise a bad group or field is
 * skipped (and later falls back to the default).
 */
function readFields(raw: unknown, strict: boolean): Fields | null {
  if (!isObject(raw)) return null;
  if (Object.keys(raw).length === 0) return {};
  if (raw.schemaVersion !== CUSTOMIZATION_SCHEMA_VERSION) return null;

  const fields: Fields = {};
  for (const [group, value] of Object.entries(raw)) {
    if (group === "schemaVersion") continue;
    if (!(CUSTOMIZATION_GROUPS as readonly string[]).includes(group)) {
      if (strict) return null;
      continue;
    }
    const members = groupFields(group as CustomizationGroup);
    if (!isObject(value) || Object.keys(value).length === 0) {
      if (strict) return null;
      continue;
    }
    if (group === "palette") {
      const keys = Object.keys(value).sort();
      const shaped = keys.length === 2 && keys[0] === "key" && keys[1] === "kind" && value.kind === "preset";
      if (!shaped) {
        if (strict) return null;
        // Lenient: a preset key is still usable without the right wrapper.
        if (!own(value, "key")) continue;
      }
      fields.palette = value.key;
      continue;
    }
    for (const [key, choice] of Object.entries(value)) {
      const field = members.find((member) => FIELD_LOCATION[member].key === key);
      if (!field) {
        if (strict) return null;
        continue;
      }
      fields[field] = choice;
    }
  }
  return fields;
}

export type ParseCustomizationResult =
  | Readonly<{ ok: true; overrides: SiteOverrides }>
  | Readonly<{ ok: false }>;

/**
 * Write-time parser (strict). Refuses the whole document for: not an
 * object, an oversized one, a missing or wrong `schemaVersion` (unless the
 * document is `{}`), an unknown group or field, a group that isn't an
 * object (an array, a string, null) or is empty, a palette that isn't
 * `{kind: "preset", key}`, and any value that isn't exactly one of the
 * theme's options. Returns the normalized overrides (defaults dropped).
 */
export function parseCustomization(themeKey: WeddingSiteThemeKey, raw: unknown): ParseCustomizationResult {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(raw) ?? "").length;
  } catch {
    return { ok: false };
  }
  if (size > MAX_CUSTOMIZATION_BYTES) return { ok: false };
  const fields = readFields(raw, true);
  if (!fields) return { ok: false };
  const theme = getTheme(themeKey);
  for (const field of CUSTOMIZABLE_FIELDS) {
    if (own(fields, field) && !isAllowedValue(theme, field, fields[field])) return { ok: false };
  }
  return { ok: true, overrides: normalizeOverrides(themeKey, fields as SiteOverrides) };
}

/**
 * Render-time reader (lenient): never trusts what is stored. Anything that
 * isn't a version-1 document is no customization; inside one, each field
 * that isn't one of the theme's options is ignored (its default applies).
 * Never throws.
 */
export function readCustomization(themeKey: WeddingSiteThemeKey, raw: unknown): SiteOverrides {
  try {
    const fields = readFields(raw, false);
    return fields ? normalizeOverrides(themeKey, fields as SiteOverrides) : {};
  } catch {
    return {};
  }
}

/**
 * Puts per-field values into the document's groups, unchecked: what a form
 * sent, before `parseCustomization` decides whether it is valid.
 */
export function customizationDocument(values: Readonly<Partial<Record<CustomizableField, string>>>): unknown {
  const groups: Partial<Record<CustomizationGroup, Record<string, string>>> = {};
  for (const field of CUSTOMIZABLE_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    const { group, key } = FIELD_LOCATION[field];
    groups[group] = { ...(group === "palette" ? { kind: "preset" } : {}), ...groups[group], [key]: value };
  }
  if (Object.keys(groups).length === 0) return {};
  return { schemaVersion: CUSTOMIZATION_SCHEMA_VERSION, ...groups };
}

/** The overrides as the stored document: `{}` when there are none. */
export function toStoredCustomization(overrides: SiteOverrides): StoredCustomization {
  return customizationDocument(overrides) as StoredCustomization;
}

/**
 * Changing the base theme (ADR-019 §10): keep only the overrides the new
 * theme also allows; any other falls back to the new theme's default and is
 * dropped, so no invalid combination is ever kept. `dropped` lists the
 * fields whose choice the new theme doesn't offer (a choice that equals the
 * new default is kept visually, so it isn't counted).
 */
export function overridesForTheme(
  themeKey: WeddingSiteThemeKey,
  overrides: SiteOverrides,
): Readonly<{ overrides: SiteOverrides; dropped: CustomizableField[] }> {
  const theme = getTheme(themeKey);
  const dropped = CUSTOMIZABLE_FIELDS.filter(
    (field) => overrides[field] !== undefined && !isAllowedValue(theme, field, overrides[field]),
  );
  return { overrides: normalizeOverrides(themeKey, overrides), dropped };
}

/** Resets one group (its fields go back to the theme's defaults), or everything. */
export function resetOverrides(overrides: SiteOverrides, group: CustomizationGroup | "all"): SiteOverrides {
  if (group === "all") return {};
  const result: Partial<Record<CustomizableField, string>> = { ...overrides };
  for (const field of groupFields(group)) delete result[field];
  return result as SiteOverrides;
}

/** Whether two sets of overrides choose the same values. */
export function sameOverrides(a: SiteOverrides, b: SiteOverrides): boolean {
  return CUSTOMIZABLE_FIELDS.every((field) => a[field] === b[field]);
}

/** The groups that have at least one override. */
export function customizedGroups(overrides: SiteOverrides): CustomizationGroup[] {
  return CUSTOMIZATION_GROUPS.filter((group) => groupFields(group).some((field) => overrides[field] !== undefined));
}

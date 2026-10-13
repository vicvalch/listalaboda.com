"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import {
  checkContrast,
  COLOR_PARAMS,
  CONTRAST_PAIRS,
  CUSTOM_PALETTE_CHOICE,
  MIN_CONTRAST,
  normalizeHexInput,
  SITE_COLOR_ROLES,
  type SiteColorRole,
  type SiteColors,
} from "@/lib/wedding-site/design/colors";
import type { SitePalette } from "@/lib/wedding-site/design/themes";

import { useSubmitBlocked } from "./CustomizeForm";

/**
 * The palette field of "Personalizar" (ADR-019): the theme's presets as
 * native radios plus "Colores personalizados" (CP7), which opens six color
 * controls. Each color has a native picker and a visible code field (the one
 * the form sends, as `#rrggbb`), both labelled in words; contrast is checked
 * live with the same rules the server and the database apply (`colors.ts`),
 * every problem is tied to the fields it concerns, and preview and save wait
 * until the palette is valid. Without JavaScript the radios and code fields
 * still work and the server explains a refusal.
 */
export function PaletteField({
  options,
  defaultValue,
  selected,
  colors,
  themeName,
}: {
  options: readonly SitePalette[];
  defaultValue: SitePalette;
  /** A preset key, or `custom`. */
  selected: string;
  /** The custom palette the controls start from (the saved or previewed one, or the theme's seed). */
  colors: SiteColors;
  themeName: string;
}) {
  const copy = getMessages().site.customize;
  const id = useId();
  const [choice, setChoice] = useState(selected);
  const [codes, setCodes] = useState<Record<SiteColorRole, string>>({ ...colors });
  const { setBlocked } = useSubmitBlocked();

  const canonical = Object.fromEntries(
    SITE_COLOR_ROLES.map((role) => [role, normalizeHexInput(codes[role])]),
  ) as Record<SiteColorRole, string | null>;
  const malformed = SITE_COLOR_ROLES.filter((role) => canonical[role] === null);
  const failing =
    malformed.length === 0 ? checkContrast(canonical as SiteColors).filter((check) => !check.ok) : [];
  const custom = choice === CUSTOM_PALETTE_CHOICE;
  const problems = malformed.length + failing.length;
  const blocked = custom && problems > 0;

  useEffect(() => {
    setBlocked(blocked);
    return () => setBlocked(false);
  }, [blocked, setBlocked]);

  // Problem ids by role: a pair's message describes both of its colors.
  const describedBy = (role: SiteColorRole) =>
    [
      malformed.includes(role) ? `${id}-${role}-format` : null,
      ...failing
        .filter((check) => {
          const pair = CONTRAST_PAIRS.find((candidate) => candidate.id === check.id);
          return pair?.foreground === role || pair?.background === role;
        })
        .map((check) => `${id}-${check.id}`),
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const radio = (value: string, label: ReactNode) => (
    <label
      key={value}
      className="inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm has-checked:border-accent has-checked:font-semibold"
    >
      <input
        type="radio"
        name="palette"
        value={value}
        checked={choice === value}
        onChange={() => setChoice(value)}
        className="h-4 w-4 shrink-0 accent-accent"
      />
      {label}
    </label>
  );

  return (
    // The colors show while "Colores personalizados" is checked: by CSS, so
    // the field also opens without JavaScript.
    <div className="group/palette min-w-0 space-y-3">
      <fieldset className="min-w-0 space-y-2" data-testid="site-customize-field" data-field="palette">
        <legend className="text-sm font-semibold">{copy.fields.palette}</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((value) =>
            radio(
              value,
              <>
                <Swatch palette={value} />
                <span className="min-w-0 break-words">
                  {copy.values.palette[value]}
                  {value === defaultValue ? <span className="text-muted font-normal"> · {copy.themeDefault}</span> : null}
                </span>
              </>,
            ),
          )}
          {radio(CUSTOM_PALETTE_CHOICE, <span className="min-w-0 break-words">{copy.colors.option}</span>)}
        </div>
      </fieldset>

      <fieldset
        className="hidden min-w-0 space-y-3 rounded-lg border border-border p-3 group-has-[[value=custom]:checked]/palette:block"
        data-testid="site-customize-colors"
      >
        <legend className="px-1 text-sm font-semibold">{copy.colors.legend}</legend>
        <p className="text-muted text-sm">{copy.colors.intro}</p>
        <p className="text-muted text-sm" data-testid="site-customize-colors-light-only">
          {interpolate(copy.colors.lightOnly, { name: themeName })}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {SITE_COLOR_ROLES.map((role) => {
            const name = copy.colors.roles[role];
            const value = canonical[role];
            const invalid = malformed.includes(role) || describedBy(role) !== undefined;
            return (
              <div key={role} className="min-w-0 space-y-1" data-testid="site-customize-color" data-role={role}>
                <label htmlFor={`${id}-${role}-code`} className="block text-sm font-medium">
                  {name}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={value ?? colors[role]}
                    onChange={(event) => setCodes((current) => ({ ...current, [role]: event.target.value.toLowerCase() }))}
                    aria-label={interpolate(copy.colors.picker, { role: name })}
                    aria-describedby={describedBy(role)}
                    className="h-11 w-14 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-1"
                  />
                  <input
                    id={`${id}-${role}-code`}
                    type="text"
                    name={COLOR_PARAMS[role]}
                    value={codes[role]}
                    onChange={(event) => {
                      const next = event.target.value;
                      setCodes((current) => ({ ...current, [role]: normalizeHexInput(next) ?? next }));
                    }}
                    maxLength={7}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy(role)}
                    className="min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 font-mono text-sm"
                  />
                </div>
                {malformed.includes(role) ? (
                  <p id={`${id}-${role}-format`} className="text-danger text-sm">
                    {copy.colors.format}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        <ul className="space-y-2" data-testid="site-customize-contrast">
          {failing.map((check) => (
            <li key={check.id} id={`${id}-${check.id}`} className="text-danger text-sm" data-pair={check.id}>
              {copy.colors.pairs[check.id]}{" "}
              <span className="text-muted">
                {interpolate(copy.colors.ratio, {
                  ratio: formatNumber(Math.floor(check.ratio * 100) / 100, { maximumFractionDigits: 2 }),
                  min: formatNumber(MIN_CONTRAST, { maximumFractionDigits: 1 }),
                })}
              </span>
            </li>
          ))}
        </ul>
        {/* One summary, announced politely as it changes; the details stay next to the fields. */}
        <p role="status" className="text-sm font-medium" data-testid="site-customize-colors-status">
          {custom
            ? problems === 0
              ? copy.colors.valid
              : problems === 1
                ? copy.colors.problem
                : interpolate(copy.colors.problems, { count: String(problems) })
            : null}
        </p>
      </fieldset>
    </div>
  );
}

/** Two dots in the palette's own background and accent tokens. Decorative: the name says it. */
function Swatch({ palette }: { palette: SitePalette }) {
  return (
    <span
      aria-hidden="true"
      data-site-palette={palette === "app" ? undefined : palette}
      className="inline-flex h-5 w-8 shrink-0 overflow-hidden rounded-full border border-border"
    >
      <span className="h-full w-1/2 bg-background" />
      <span className="h-full w-1/2 bg-accent" />
    </span>
  );
}

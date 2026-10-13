import type { ReactNode } from "react";

import { getMessages, interpolate } from "@/lib/i18n";
import { CUSTOM_COLOR_SEEDS, CUSTOM_PALETTE_CHOICE } from "@/lib/wedding-site/design/colors";
import { customizedGroups, groupFields, type CustomizationGroup } from "@/lib/wedding-site/design/customization";
import { resolveWeddingSiteDesign, type WeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import { getTheme, type CustomizableField } from "@/lib/wedding-site/design/themes";

import { CustomizeButton, CustomizeForm } from "./CustomizeForm";
import { PaletteField } from "./PaletteField";

/** The groups drawn, in order. Custom colors live inside "Paleta" (one palette choice). */
const FORM_GROUPS = ["palette", "typography", "hero", "layout"] as const satisfies readonly CustomizationGroup[];

/**
 * "Personalizar" (ADR-019, CP6): the closed options of ONE theme, read from
 * the registry (`ThemeDefinition.options`, never a list of its own), as
 * native radio groups in four groups (palette, typography, hero, layout).
 * Each option is named in words; the theme's default says so; a field the
 * theme fixes is stated, not offered. The palette also offers "Colores
 * personalizados" (CP7, `PaletteField`), with live contrast checks.
 *
 * `design` is what the controls start from (the saved design on the site
 * page, the previewed one in the preview). On the site page (`mode="site"`)
 * each customized group of the SAVED design (`saved`) can be reset (custom
 * colors on their own), and so can everything.
 */
export function CustomizeSection({
  weddingId,
  design,
  saved,
  mode,
  headingLevel,
}: {
  weddingId: string;
  design: WeddingSiteDesign;
  saved: WeddingSiteDesign;
  mode: "site" | "preview";
  /** The level of the section title; groups are one level below. */
  headingLevel: 2 | 3;
}) {
  const copy = getMessages().site;
  const theme = getTheme(design.themeKey);
  const resolved = resolveWeddingSiteDesign(design);
  const resettable = mode === "site" && saved.themeKey === design.themeKey ? customizedGroups(saved.customization) : [];
  const Title = headingLevel === 2 ? "h2" : "h3";
  const GroupTitle = headingLevel === 2 ? "h3" : "h4";
  const titleId = `site-customize-${mode}-title`;

  return (
    <section aria-labelledby={titleId} className="space-y-4" data-testid="site-customize" data-theme={theme.key}>
      <header className="space-y-1">
        <Title id={titleId} className="text-lg font-semibold">
          {interpolate(copy.customize.title, { name: copy.themes[theme.key].name })}
        </Title>
        <p className="text-muted text-sm">{copy.customize.intro}</p>
        {mode === "site" && resettable.length === 0 ? <p className="text-muted text-sm">{copy.customize.none}</p> : null}
      </header>

      <CustomizeForm weddingId={weddingId} theme={theme.key}>
        {/* Keyed by the design the radios start from: a new theme or a saved
            change remounts them, so no radio keeps a checked state from the
            previous design (uncontrolled inputs don't follow defaultChecked
            once rendered). The form itself stays, so its status survives. */}
        <div key={`${theme.key}:${JSON.stringify(resolved)}`} className="space-y-4">
          {FORM_GROUPS.map((group) => (
            <Group
              key={group}
              group={group}
              GroupTitle={GroupTitle}
              mode={mode}
              resettable={resettable.includes(group)}
              colorsResettable={group === "palette" && resettable.includes("colors")}
            >
              {groupFields(group).map((field) =>
                field === "palette" ? (
                  <PaletteField
                    key={field}
                    options={theme.options.palette}
                    defaultValue={theme.palette}
                    selected={resolved.colors ? CUSTOM_PALETTE_CHOICE : resolved.palette}
                    colors={resolved.colors ?? CUSTOM_COLOR_SEEDS[theme.key]}
                    themeName={copy.themes[theme.key].name}
                  />
                ) : (
                  <Field key={field} field={field} options={theme.options[field]} defaultValue={theme[field]} selected={resolved[field]} />
                ),
              )}
            </Group>
          ))}
        </div>

        <div className="flex flex-wrap gap-3">
          <CustomizeButton intent="preview" label={copy.customize.preview} pendingLabel={copy.customize.saving} />
          <CustomizeButton
            intent="save"
            tone="primary"
            label={mode === "site" ? copy.customize.save : copy.customize.saveDesign}
            pendingLabel={copy.customize.saving}
          />
          {resettable.length > 0 ? (
            <CustomizeButton intent="reset:all" label={copy.customize.resetAll} pendingLabel={copy.customize.saving} />
          ) : null}
        </div>
      </CustomizeForm>
    </section>
  );
}

function Group({
  group,
  GroupTitle,
  mode,
  resettable,
  colorsResettable = false,
  children,
}: {
  group: CustomizationGroup;
  GroupTitle: "h3" | "h4";
  mode: "site" | "preview";
  resettable: boolean;
  /** The saved design has custom colors (only in the palette group). */
  colorsResettable?: boolean;
  children: ReactNode;
}) {
  const copy = getMessages().site.customize;
  const id = `site-customize-${mode}-${group}`;
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 space-y-3 rounded-xl border border-border p-3 sm:p-4"
      data-testid="site-customize-group"
      data-group={group}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <GroupTitle id={id} className="font-semibold">
          {copy.groups[group]}
        </GroupTitle>
        {resettable ? (
          <CustomizeButton
            intent={`reset:${group}`}
            label={copy.reset}
            name={copy.groups[group]}
            pendingLabel={copy.saving}
          />
        ) : null}
        {colorsResettable ? (
          <CustomizeButton
            intent="reset:colors"
            label={copy.reset}
            name={copy.groups.colors}
            pendingLabel={copy.saving}
          />
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One customizable field (all but the palette): a radio per option the
 * theme offers, in registry order, named in words. Selection is shown by
 * the radio itself and bold text, not by color alone.
 */
function Field({
  field,
  options,
  defaultValue,
  selected,
}: {
  field: CustomizableField;
  options: readonly string[];
  defaultValue: string;
  selected: string;
}) {
  const copy = getMessages().site.customize;
  const names = copy.values[field] as Record<string, string>;
  if (options.length < 2) {
    return (
      <p className="text-sm" data-testid="site-customize-fixed" data-field={field}>
        <span className="font-semibold">{copy.fields[field]}.</span>{" "}
        <span className="text-muted">{interpolate(copy.fixed, { value: names[defaultValue] })}</span>
      </p>
    );
  }
  return (
    <fieldset className="min-w-0 space-y-2" data-testid="site-customize-field" data-field={field}>
      <legend className="text-sm font-semibold">{copy.fields[field]}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((value) => (
          <label
            key={value}
            className="inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm has-checked:border-accent has-checked:font-semibold"
          >
            <input type="radio" name={field} value={value} defaultChecked={value === selected} className="h-4 w-4 shrink-0 accent-accent" />
            <span className="min-w-0 break-words">
              {names[value]}
              {value === defaultValue ? <span className="text-muted font-normal"> · {copy.themeDefault}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

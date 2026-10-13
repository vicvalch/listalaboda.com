import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sameOverrides } from "@/lib/wedding-site/design/customization";
import { resolveWeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import { WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";
import { previewDesign, sitePreviewPath, toPreviewSite } from "@/lib/wedding-site/preview";
import { getWeddingSiteEditor } from "@/lib/wedding-site/service";
import { getWeddingDetail } from "@/lib/weddings/service";

import { CustomizeSection } from "../CustomizeSection";
import { ThemeForm, ThemeSubmitButton } from "../ThemeForm";

export const metadata: Metadata = {
  title: getMessages().site.preview.title,
  // Private by nature; never indexed or followed.
  robots: { index: false, follow: false },
};

/**
 * Member-only design preview (ADR-019, CP5/CP6): the wedding's site drawn in
 * the `?theme=` theme — with the customization choosing it would keep, or
 * with unsaved customization choices (`customize=1` plus one closed value
 * per field, `previewDesign`) — exactly as the public page would draw it
 * (the same `WeddingSite` renderer and the same shaping, `toPreviewSite`),
 * published or not. The data is what the member already reads through RLS —
 * the wedding's name, date and city and its visible sections — and nothing
 * else reaches the renderer. Opening it never writes: saving is an explicit
 * "Usar este estilo" or "Guardar este diseño" (the same saves as the site
 * page). A non-member, a nonexistent wedding and a malformed id all get the
 * same 404.
 */
export default async function WeddingSitePreviewPage({
  params,
  searchParams,
}: PageProps<"/app/weddings/[weddingId]/site/preview">) {
  const { weddingId } = await params;
  const sitePath = `/app/weddings/${encodeURIComponent(weddingId)}/site`;
  await requireUser(`${sitePath}/preview`);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(`${sitePath}/preview`));
    notFound();
  }

  const [wedding, editor] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    getWeddingSiteEditor(supabase, access.access),
  ]);
  if (!wedding) notFound();

  const copy = getMessages().site;
  if (!editor) {
    return (
      <div className="space-y-4">
        <Notice tone="error">{copy.loadFailed}</Notice>
        <p>
          <Link href={sitePath} className={textLinkClass}>
            {copy.preview.back}
          </Link>
        </p>
      </div>
    );
  }

  const saved = editor.design;
  const current = saved.themeKey;
  const { design, custom } = previewDesign(await searchParams, saved);
  const themeKey = design.themeKey;
  const theme = copy.themes[themeKey];
  const isCurrent = themeKey === current && sameOverrides(design.customization, saved.customization);
  const isPublished = Boolean(editor.publication?.publishedAt);
  const site = toPreviewSite(wedding, editor.sections, editor.publication?.slug ?? "");

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight" data-testid="site-preview-title">
          {interpolate(custom ? copy.preview.customHeading : copy.preview.heading, { name: theme.name })}
        </h1>
        <p className="text-muted">{copy.preview.note}</p>
        <p className="text-muted text-sm">{copy.preview.membersOnly}</p>
        {isPublished ? null : <p className="text-sm font-semibold">{copy.preview.unpublished}</p>}
        <p>
          <Link href={sitePath} className={`${textLinkClass} text-sm`}>
            {copy.preview.back}
          </Link>
        </p>
      </header>

      <nav aria-label={copy.preview.otherThemes} className="space-y-2">
        <p className="text-sm font-semibold">{copy.preview.otherThemes}</p>
        <ul className="flex flex-wrap gap-2">
          {WEDDING_SITE_THEME_KEYS.map((key) => (
            <li key={key}>
              <Link
                href={sitePreviewPath(wedding.id, key)}
                aria-current={key === themeKey ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${
                  key === themeKey
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-border bg-surface hover:bg-accent-soft"
                }`}
              >
                {copy.themes[key].name}
                {key === current ? <span className="font-normal">&nbsp;· {copy.design.selected}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* The form stays mounted after a save, so its result is still announced
          once this theme has become the current one. Unsaved customization
          choices are saved by the customization form below instead. */}
      <ThemeForm weddingId={wedding.id}>
        {isCurrent ? (
          <p className="font-semibold" data-testid="site-preview-current">
            {custom ? copy.preview.currentDesign : copy.preview.current}
          </p>
        ) : custom ? (
          <p className="font-semibold" data-testid="site-preview-unsaved">
            {copy.preview.customNote}
          </p>
        ) : (
          <ThemeSubmitButton
            theme={themeKey}
            label={copy.design.use}
            pendingLabel={copy.design.saving}
            name={theme.name}
          />
        )}
      </ThemeForm>

      {/* Native disclosure (no script); open while trying unsaved choices. */}
      <details open={custom} className="rounded-2xl border border-border bg-surface p-4 sm:p-5" data-testid="site-preview-customize">
        <summary className="cursor-pointer font-semibold">{copy.preview.customize}</summary>
        <div className="mt-4">
          <CustomizeSection weddingId={wedding.id} design={design} saved={saved} mode="preview" headingLevel={2} />
        </div>
      </details>

      {/* The site itself, inside a frame: a page region, not a second page.
          Wider than the app column on large screens, like the seating
          planner (page-local negative margins, never 100vw). */}
      <section
        aria-label={copy.preview.canvasLabel}
        data-testid="site-preview"
        data-theme={themeKey}
        className="overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-sm lg:-mx-8 xl:-mx-24"
      >
        <WeddingSite site={site} design={resolveWeddingSiteDesign(design)} element="div" />
      </section>
    </div>
  );
}

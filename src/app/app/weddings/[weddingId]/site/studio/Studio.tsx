"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getMessages, interpolate } from "@/lib/i18n";
import { resolveWeddingSiteDesign, type WeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import { blockStatus, canAddBlock, coverOf, type EditorPhoto, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { memberPhotoBasePath, type SitePhotoBlock } from "@/lib/wedding-site/photos/model";
import type { SiteHeader } from "@/lib/wedding-site/preview";
import { hasPublicContent, SECTION_KINDS, type EditorSection, type SectionKind } from "@/lib/wedding-site/sections";
import {
  blockDraftOf,
  canvasWidth,
  elementBlock,
  hasDrafts,
  INSERTABLE_ELEMENTS,
  NO_DRAFTS,
  sameBlockDraft,
  sameSectionDraft,
  sameTarget,
  sectionDraftOf,
  studioEditor,
  studioPhotoBlocks,
  studioSections,
  studioSite,
  type BlockDraft,
  type InsertableElement,
  type SectionDraft,
  type StudioDevice,
  type StudioDrafts,
  type StudioTarget,
} from "@/lib/wedding-site/studio";

import { saveSectionAction } from "../actions";
import {
  addToBlockAction,
  createStudioBlockAction,
  deleteBlockAction,
  moveAction,
  removeCoverAction,
  removeFromBlockAction,
  saveBlockAction,
  savePhotoAction,
  setBlockVisibilityAction,
  setCoverAction,
  type PhotoFormState,
} from "../photos/actions";
import { blockName } from "../photos/controls";
import { CanvasFrame } from "./CanvasFrame";
import { ElementIcon } from "./icons";
import { StudioCanvas, type CanvasBlockInfo } from "./StudioCanvas";
import { BlockPanel, CoverPanel, EmptyPanel, SectionPanel, type Act, type Outcome, type SaveOutcome } from "./StudioPanels";

/** Everything Studio draws, read on the server through the member's own session (RLS). */
export type StudioData = Readonly<{
  weddingId: string;
  header: SiteHeader;
  slug: string;
  isPublished: boolean;
  isOwner: boolean;
  sections: readonly EditorSection[];
  design: WeddingSiteDesign;
  /** Null: photos off (flag) or unreadable; Studio is then text-only. */
  photos: PhotoEditor | null;
}>;

type Notice = Readonly<{ text: string; tone: "status" | "error"; nonce: number }>;

/** Drafts that now equal the saved values are no longer drafts (after a save and refresh, or typed back). */
function prune(drafts: StudioDrafts, data: StudioData): StudioDrafts {
  const sections: Partial<Record<SectionKind, SectionDraft>> = {};
  for (const [kind, draft] of Object.entries(drafts.sections) as [SectionKind, SectionDraft][]) {
    const saved = data.sections.find((section) => section.kind === kind);
    if (saved && !sameSectionDraft(draft, sectionDraftOf(saved))) sections[kind] = draft;
  }
  const blocks: Record<string, BlockDraft> = {};
  for (const [id, draft] of Object.entries(drafts.blocks)) {
    const saved = data.photos?.blocks.find((block) => block.id === id);
    if (saved && !sameBlockDraft(draft, blockDraftOf(saved))) blocks[id] = draft;
  }
  return { sections, blocks };
}

function fromPhoto(state: PhotoFormState, failed: string): Outcome {
  return state?.ok ? { ok: true, message: state.data.message } : { ok: false, error: state?.formError ?? failed };
}

/**
 * ListaLaBoda Studio (STUDIO-01): a full-screen modal workspace (the native
 * <dialog> keeps the app behind it inert) with the element library on the
 * left, the couple's real site in the middle and the selected element's
 * properties on the right; drawers below `lg`. Click-to-add only: no drag.
 */
export function Studio({ data }: { data: StudioData }) {
  const router = useRouter();
  const copy = getMessages().site.studio;
  const failed = copy.panel.failed;
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<StudioTarget | null>(null);
  const [drafts, setDrafts] = useState<StudioDrafts>(NO_DRAFTS);
  const [inserting, setInserting] = useState<InsertableElement | null>(null);
  const [device, setDevice] = useState<StudioDevice>("desktop");
  const [drawer, setDrawer] = useState<"palette" | "properties" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const sitePath = `/app/weddings/${encodeURIComponent(data.weddingId)}/site`;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  // Saved data came back: drop the drafts it now matches (adjusting state on a new prop, during render).
  const [seen, setSeen] = useState(data);
  if (seen !== data) {
    setSeen(data);
    setDrafts((current) => prune(current, data));
  }

  // Never lose typed changes silently when leaving the page.
  const dirty = hasDrafts(drafts);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const announce = useCallback((text: string, tone: Notice["tone"]) => setNotice({ text, tone, nonce: Date.now() }), []);
  // The visible toast steps aside after a few seconds (it must never cover the canvas); the text stays for screen readers.
  const [faded, setFaded] = useState<number | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setFaded(notice.nonce), notice.tone === "error" ? 8000 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const toastVisible = notice !== null && faded !== notice.nonce;

  const form = useCallback(
    (fields: Record<string, string>) => {
      const body = new FormData();
      body.set("weddingId", data.weddingId);
      for (const [name, value] of Object.entries(fields)) body.set(name, value);
      return body;
    },
    [data.weddingId],
  );

  const act: Act = useCallback(
    async (work) => {
      setBusy(true);
      try {
        const result = await work();
        announce(result.ok ? result.message : result.error, result.ok ? "status" : "error");
        if (result.ok) router.refresh();
        return result.ok;
      } finally {
        setBusy(false);
      }
    },
    [announce, router],
  );

  // ---------------------------------------------------------------- model
  const sections = useMemo(() => studioSections(data.sections, drafts), [data.sections, drafts]);
  const site = useMemo(() => studioSite(data.header, sections, data.slug), [data.header, sections, data.slug]);
  const editor = useMemo(() => (data.photos ? studioEditor(data.photos, drafts) : null), [data.photos, drafts]);
  const canvasPhotos = useMemo(() => {
    if (!editor) return { blocks: [] as SitePhotoBlock[], info: new Map<SitePhotoBlock, CanvasBlockInfo>() };
    const { blocks, ids } = studioPhotoBlocks(editor);
    const info = new Map<SitePhotoBlock, CanvasBlockInfo>();
    for (const [drawn, id] of ids) {
      const block = editor.blocks.find((b) => b.id === id);
      if (block) info.set(drawn, { id, name: blockName(block, editor), missingAlt: blockStatus(editor, block).missingAlt });
    }
    return { blocks, info };
  }, [editor]);
  const design = useMemo(() => resolveWeddingSiteDesign(data.design), [data.design]);
  const hiddenSections = new Set(sections.filter((s) => !s.isVisible && hasPublicContent(s.kind, s.body)).map((s) => s.kind));
  const emptySections = new Set(sections.filter((s) => !hasPublicContent(s.kind, s.body)).map((s) => s.kind));
  const cover = editor ? coverOf(editor).block : null;
  const unsaved = new Set([
    ...Object.keys(drafts.sections).map((kind) => `section:${kind}`),
    ...Object.keys(drafts.blocks).map((id) => (data.photos?.blocks.find((b) => b.id === id)?.kind === "cover" ? "cover" : `block:${id}`)),
  ]);
  const canAdd = data.photos ? canAddBlock(data.photos) : false;

  // -------------------------------------------------------------- choose
  const narrow = () => typeof window !== "undefined" && !window.matchMedia("(min-width: 64rem)").matches;
  const select = (target: StudioTarget) => {
    setSelected(target);
    if (narrow()) setDrawer("properties");
  };
  const startInsert = (element: InsertableElement) => {
    setInserting(element);
    setDrawer(null);
    announce(interpolate(copy.insert.banner, { element: copy.palette.elements[element].name }), "status");
  };

  const insert = async (anchor: SectionKind | null) => {
    if (!inserting) return;
    const element = inserting;
    const { kind, variant } = elementBlock(element);
    setBusy(true);
    try {
      const result = await createStudioBlockAction(form({ kind, variant, anchor: anchor ?? "top" }));
      if (!result.ok) return announce(result.formError, "error");
      setInserting(null);
      setSelected({ type: "block", id: result.blockId });
      if (narrow()) setDrawer("properties");
      announce(interpolate(copy.insert.added, { element: copy.palette.elements[element].name }), "status");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  // --------------------------------------------------------------- saves
  const saveSection = async (kind: SectionKind): Promise<SaveOutcome> => {
    const saved = data.sections.find((section) => section.kind === kind);
    if (!saved) return { ok: false, error: failed };
    const value = drafts.sections[kind] ?? sectionDraftOf(saved);
    const state = await saveSectionAction(
      null,
      form({ kind, title: value.title, body: value.body, ...(value.isVisible ? { visible: "on" } : {}) }),
    );
    if (state?.ok) {
      router.refresh();
      return { ok: true, message: state.data.message };
    }
    return { ok: false, error: state?.formError, fieldErrors: state?.fieldErrors };
  };

  const saveBlock = async (id: string): Promise<SaveOutcome> => {
    const saved = data.photos?.blocks.find((block) => block.id === id);
    if (!saved) return { ok: false, error: failed };
    const value = drafts.blocks[id] ?? blockDraftOf(saved);
    const state = await saveBlockAction(
      null,
      form({
        blockId: id,
        kind: saved.kind,
        ...(value.isVisible ? { visible: "on" } : {}),
        anchor: value.anchor ?? "top",
        variant: value.variant,
        title: value.title,
        body: value.body,
      }),
    );
    if (state?.ok) {
      router.refresh();
      return { ok: true, message: state.data.message };
    }
    return { ok: false, error: state?.formError ?? failed };
  };

  const setSectionDraft = (kind: SectionKind, next: SectionDraft) =>
    setDrafts((current) => {
      const saved = data.sections.find((section) => section.kind === kind);
      const sectionsDrafts = { ...current.sections };
      if (saved && sameSectionDraft(next, sectionDraftOf(saved))) delete sectionsDrafts[kind];
      else sectionsDrafts[kind] = next;
      return { ...current, sections: sectionsDrafts };
    });
  const setBlockDraft = (id: string, next: BlockDraft) =>
    setDrafts((current) => {
      const saved = data.photos?.blocks.find((block) => block.id === id);
      const blocks = { ...current.blocks };
      if (saved && sameBlockDraft(next, blockDraftOf(saved))) delete blocks[id];
      else blocks[id] = next;
      return { ...current, blocks };
    });
  const discard = (target: StudioTarget) =>
    setDrafts((current) => {
      if (target.type === "section") {
        const sectionsDrafts = { ...current.sections };
        delete sectionsDrafts[target.kind];
        return { ...current, sections: sectionsDrafts };
      }
      if (target.type === "block") {
        const blocks = { ...current.blocks };
        delete blocks[target.id];
        return { ...current, blocks };
      }
      return current;
    });

  // ------------------------------------------------------------- panels
  const panel = (() => {
    if (!selected) return <EmptyPanel isPublished={data.isPublished} />;
    if (selected.type === "cover") {
      return (
        <CoverPanel
          weddingId={data.weddingId}
          header={data.header}
          isOwner={data.isOwner}
          editor={data.photos}
          act={act}
          setCover={async (photoId) => fromPhoto(await setCoverAction(null, form({ photoId })), failed)}
          setCoverVisible={async (blockId, visible) =>
            fromPhoto(
              await setBlockVisibilityAction(
                null,
                form({ blockId, visible: visible ? "on" : "off", name: getMessages().site.compose.cover.photoTitle }),
              ),
              failed,
            )
          }
          removeCover={async (photoId) => {
            const state = await removeCoverAction(null, form({ photoId }));
            return state?.ok ? { ok: true, message: copy.panel.cover.removed } : { ok: false, error: state?.formError ?? failed };
          }}
        />
      );
    }
    if (selected.type === "section") {
      const section = data.sections.find((s) => s.kind === selected.kind);
      if (!section) return <EmptyPanel isPublished={data.isPublished} />;
      return (
        <SectionPanel
          key={selected.kind}
          section={section}
          draft={drafts.sections[selected.kind]}
          onDraft={(next) => setSectionDraft(selected.kind, next)}
          onDiscard={() => discard(selected)}
          onSave={() => saveSection(selected.kind)}
          isPublished={data.isPublished}
        />
      );
    }
    const block = data.photos?.blocks.find((b) => b.id === selected.id);
    if (!block || !data.photos) {
      return <p className="text-muted p-2 text-sm">{copy.panel.loading}</p>;
    }
    const name = blockName(block, data.photos);
    return (
      <BlockPanel
        key={block.id}
        weddingId={data.weddingId}
        editor={data.photos}
        block={block}
        name={name}
        draft={drafts.blocks[block.id]}
        onDraft={(next) => setBlockDraft(block.id, next)}
        onDiscard={() => discard(selected)}
        onSave={() => saveBlock(block.id)}
        act={act}
        isPublished={data.isPublished}
        actions={{
          addPhotos: async (photoIds) => {
            for (const photoId of photoIds) {
              const state = await addToBlockAction(null, form({ photoId, blockId: block.id }));
              if (!state?.ok) return { ok: false, error: state?.formError ?? failed };
            }
            return {
              ok: true,
              message:
                photoIds.length === 1
                  ? getMessages().site.photos.library.added
                  : interpolate(copy.panel.block.addedMany, { count: String(photoIds.length) }),
            };
          },
          removePhoto: async (photoId) => fromPhoto(await removeFromBlockAction(null, form({ photoId })), failed),
          movePhoto: async (photoId, direction, label) =>
            fromPhoto(await moveAction(null, form({ target: "photo", id: photoId, direction, name: `${label} (${name})` })), failed),
          moveBlock: async (direction) =>
            fromPhoto(await moveAction(null, form({ target: "block", id: block.id, direction, name })), failed),
          describePhoto: async (photo: EditorPhoto, altText, caption) =>
            fromPhoto(
              await savePhotoAction(
                null,
                form({
                  photoId: photo.id,
                  altText,
                  caption,
                  focalX: String(Math.round(photo.focalX / 100)),
                  focalY: String(Math.round(photo.focalY / 100)),
                }),
              ),
              failed,
            ),
          deleteBlock: async () => {
            const state = await deleteBlockAction(null, form({ blockId: block.id }));
            if (state?.ok) setSelected(null);
            return state?.ok ? { ok: true, message: copy.panel.block.deleted } : { ok: false, error: state?.formError ?? failed };
          },
        }}
      />
    );
  })();

  // -------------------------------------------------------------- layout
  const drawerClass = (which: "palette" | "properties") =>
    `${drawer === which ? "fixed inset-y-0 z-30 flex w-[min(22rem,88vw)] shadow-2xl" : "hidden"} ${
      which === "palette" ? "left-0 border-r" : "right-0 border-l"
    } flex-col overflow-y-auto border-border bg-surface lg:static lg:z-auto lg:flex lg:w-auto lg:shadow-none`;

  return (
    <dialog
      ref={dialog}
      aria-label={copy.title}
      onCancel={(event) => {
        // Escape cancels an insertion or closes a drawer; it never closes Studio.
        event.preventDefault();
        if (inserting) setInserting(null);
        else setDrawer(null);
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-background p-0 text-foreground backdrop:bg-background"
      data-testid="studio"
    >
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        {/* ------------------------------------------------------- top bar */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
          <a href={sitePath} className="text-sm font-semibold hover:underline" data-testid="studio-exit">
            ← {copy.exit}
          </a>
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="font-serif text-lg">{copy.title}</span>
            <span className="text-muted"> · {data.header.name}</span>
          </p>
          <div role="group" aria-label={copy.devices.label} className="hidden rounded-full border border-border p-0.5 text-sm sm:flex">
            {(["desktop", "mobile"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={device === option}
                onClick={() => setDevice(option)}
                className={`rounded-full px-3 py-1 font-semibold ${device === option ? "bg-accent text-accent-foreground" : ""}`}
              >
                {copy.devices[option]}
              </button>
            ))}
          </div>
          <p
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              data.isPublished ? "border-success/40 bg-success-soft text-success" : "border-dashed border-border"
            }`}
            data-testid="studio-status"
          >
            {data.isPublished ? copy.published : copy.unpublished}
          </p>
          <nav aria-label={copy.title} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a href={`${sitePath}/preview`} className="font-semibold hover:underline">
              {copy.previewLink}
            </a>
            {data.photos ? (
              <a href={`${sitePath}/photos`} className="font-semibold hover:underline">
                {copy.libraryLink}
              </a>
            ) : null}
            <a href={`${sitePath}#publicar`} className="font-semibold hover:underline">
              {copy.publishLink}
            </a>
          </nav>
          <div className="flex gap-2 lg:hidden">
            <button
              type="button"
              aria-expanded={drawer === "palette"}
              onClick={() => setDrawer(drawer === "palette" ? null : "palette")}
              className="rounded-full border border-border px-3 py-1 text-sm font-semibold"
            >
              {copy.palette.open}
            </button>
            <button
              type="button"
              aria-expanded={drawer === "properties"}
              onClick={() => setDrawer(drawer === "properties" ? null : "properties")}
              className="rounded-full border border-border px-3 py-1 text-sm font-semibold"
            >
              {copy.panel.open}
            </button>
          </div>
        </header>

        <div className="relative grid min-h-0 lg:grid-cols-[17rem_minmax(0,1fr)_23rem]">
          {drawer ? (
            <button
              type="button"
              aria-label={drawer === "palette" ? copy.palette.close : copy.panel.close}
              onClick={() => setDrawer(null)}
              className="fixed inset-0 z-20 bg-foreground/20 lg:hidden"
            />
          ) : null}

          {/* ------------------------------------------------- elements */}
          <aside aria-label={copy.palette.title} className={drawerClass("palette")} data-testid="studio-palette">
            <div className="space-y-6 p-4">
              <DrawerClose label={copy.palette.close} onClose={() => setDrawer(null)} />
              <section className="space-y-2" aria-labelledby="studio-fixed">
                <h2 id="studio-fixed" className="text-muted text-xs font-semibold tracking-wide uppercase">
                  {copy.palette.fixedTitle}
                </h2>
                <p className="text-muted text-xs">{copy.palette.fixedHint}</p>
                <ul className="space-y-1">
                  <PaletteItem
                    testId="studio-palette-cover"
                    icon="cover"
                    name={copy.palette.cover}
                    badge={copy.palette.fixedBadge}
                    active={sameTarget(selected, { type: "cover" })}
                    onClick={() => select({ type: "cover" })}
                  />
                  {SECTION_KINDS.map((kind) => {
                    const section = sections.find((s) => s.kind === kind);
                    return (
                      <PaletteItem
                        key={kind}
                        testId={`studio-palette-${kind}`}
                        icon="text"
                        name={getMessages().site.kinds[kind]}
                        badge={section?.isVisible ? getMessages().site.sections.shown : getMessages().site.sections.hidden}
                        muted={!section?.isVisible}
                        unsaved={unsaved.has(`section:${kind}`)}
                        active={sameTarget(selected, { type: "section", kind })}
                        onClick={() => select({ type: "section", kind })}
                      />
                    );
                  })}
                </ul>
              </section>
              {data.photos ? (
                <section className="space-y-2" aria-labelledby="studio-add">
                  <h2 id="studio-add" className="text-muted text-xs font-semibold tracking-wide uppercase">
                    {copy.palette.addTitle}
                  </h2>
                  <p className="text-muted text-xs">{canAdd ? copy.palette.addHint : copy.palette.limit}</p>
                  <ul className="grid grid-cols-2 gap-2">
                    {INSERTABLE_ELEMENTS.map((element) => (
                      <li key={element}>
                        <button
                          type="button"
                          disabled={!canAdd || busy}
                          aria-pressed={inserting === element}
                          aria-describedby={`studio-element-${element}`}
                          onClick={() => startInsert(element)}
                          data-testid={`studio-element-${element}`}
                          className={`flex h-full w-full flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
                            inserting === element ? "border-accent bg-accent-soft" : "border-border bg-background hover:border-accent"
                          }`}
                        >
                          <ElementIcon kind={element} className="h-7 w-7 text-accent" />
                          <span className="text-sm font-semibold">{copy.palette.elements[element].name}</span>
                          <span id={`studio-element-${element}`} className="text-muted text-xs leading-snug">
                            {copy.palette.elements[element].hint}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </aside>

          {/* --------------------------------------------------- canvas */}
          <section aria-label={copy.canvas.title} className="flex min-h-0 flex-col gap-3 bg-accent-soft/40 p-3 sm:p-5">
            {inserting ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent bg-surface px-4 py-2 text-sm" data-testid="studio-insert-banner">
                <ElementIcon kind={inserting} className="h-5 w-5 text-accent" />
                <p className="min-w-0 flex-1 font-semibold">
                  {interpolate(copy.insert.banner, { element: copy.palette.elements[inserting].name })}
                </p>
                <button type="button" onClick={() => setInserting(null)} className="font-semibold underline-offset-4 hover:underline">
                  {copy.insert.cancel}
                </button>
              </div>
            ) : data.isPublished ? (
              <p className="text-muted text-center text-xs">{copy.publishedWarning}</p>
            ) : null}
            <div className="min-h-0 flex-1">
              <CanvasFrame title={copy.canvas.title} width={canvasWidth(device)} testId="studio-canvas">
                <StudioCanvas
                  site={site}
                  design={design}
                  blocks={canvasPhotos.blocks}
                  basePath={memberPhotoBasePath(data.weddingId)}
                  blockInfo={canvasPhotos.info}
                  hiddenSections={hiddenSections}
                  emptySections={emptySections}
                  coverHidden={cover ? !cover.isVisible : false}
                  unsaved={unsaved}
                  selected={selected}
                  onSelect={select}
                  inserting={inserting}
                  onInsert={insert}
                  insertBusy={busy}
                />
              </CanvasFrame>
            </div>
          </section>

          {/* ----------------------------------------------- properties */}
          <aside aria-label={copy.panel.title} className={drawerClass("properties")} data-testid="studio-properties">
            <div className="p-4 sm:p-5">
              <DrawerClose label={copy.panel.close} onClose={() => setDrawer(null)} />
              {panel}
            </div>
          </aside>
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        data-testid="studio-announcer"
        className={
          notice && toastVisible
            ? `fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-semibold shadow-md ${
                notice.tone === "error" ? "border-danger bg-danger-soft text-danger" : "border-border bg-surface"
              }`
            : "sr-only"
        }
      >
        {notice ? <span key={notice.nonce}>{notice.text}</span> : null}
      </p>
    </dialog>
  );
}

/** The drawers' own close button (below `lg` only; the columns need none). */
function DrawerClose({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <p className="mb-3 flex justify-end lg:hidden">
      <button type="button" onClick={onClose} className="rounded-full border border-border px-3 py-1 text-sm font-semibold">
        {label}
      </button>
    </p>
  );
}

function PaletteItem({
  testId,
  icon,
  name,
  badge,
  active,
  muted = false,
  unsaved = false,
  onClick,
}: {
  testId: string;
  icon: "cover" | "text";
  name: string;
  badge: string;
  active: boolean;
  muted?: boolean;
  unsaved?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        data-testid={testId}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${
          active ? "bg-accent-soft font-semibold" : "hover:bg-background"
        }`}
      >
        <ElementIcon kind={icon} className="text-muted h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {name}
          {unsaved ? <span aria-hidden="true"> •</span> : null}
        </span>
        <span className={`text-xs ${muted ? "text-muted" : "text-success"}`}>{badge}</span>
      </button>
    </li>
  );
}

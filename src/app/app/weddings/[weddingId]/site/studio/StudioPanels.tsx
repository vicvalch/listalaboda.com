"use client";

import { useId, useState, type ReactNode } from "react";

import { inputClass, primaryButtonClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import {
  blockHasRoom,
  coverOf,
  libraryPhotos,
  photosForBlock,
  photosIn,
  slotSiblings,
  type EditorBlock,
  type EditorPhoto,
  type PhotoEditor,
} from "@/lib/wedding-site/photos/editor";
import {
  memberPhotoBasePath,
  PHOTO_BLOCK_VARIANTS,
  PHOTO_LIMITS,
  photoSrc,
  SINGLE_PHOTO_KINDS,
  type PhotoBlockVariant,
} from "@/lib/wedding-site/photos/model";
import type { SiteHeader } from "@/lib/wedding-site/preview";
import {
  SECTION_BODY_MAX_LENGTH,
  SECTION_KINDS,
  SECTION_TITLE_MAX_LENGTH,
  sectionTitle,
  type EditorSection,
  type SectionKind,
} from "@/lib/wedding-site/sections";
import { blockDraftOf, sectionDraftOf, type BlockDraft, type SectionDraft } from "@/lib/wedding-site/studio";
import { formatWeddingDate } from "@/lib/weddings/format";

import { PhotoUploader } from "../photos/PhotoUploader";

/**
 * Studio's right-hand properties (STUDIO-01): the selected element's real,
 * supported fields only. Text and block fields are DRAFTS shown live on the
 * canvas and saved explicitly ("Guardar"); photo membership, order, cover
 * and descriptions are single explicit actions, applied at once. Every
 * write goes through the existing server actions (membership, validation
 * and the database's rules stay the authority).
 */

export type Outcome = Readonly<{ ok: true; message: string }> | Readonly<{ ok: false; error: string }>;
export type SaveOutcome =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; error?: string; fieldErrors?: Readonly<Partial<Record<"title" | "body" | "visible", string>>> }>;

/** Runs one action; the Studio shows its result, refreshes the canvas on success and returns whether it worked. */
export type Act = (work: () => Promise<Outcome>) => Promise<boolean>;

const small = "min-h-9 px-3 py-1.5 text-sm";

function PanelHeader({ eyebrow, title, badge }: { eyebrow: string; title: string; badge?: ReactNode }) {
  return (
    <header className="space-y-1 border-b border-border pb-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted text-xs font-semibold tracking-wide uppercase">{eyebrow}</p>
        {badge}
      </div>
      <h2 className="font-serif text-2xl leading-tight break-words" data-testid="studio-panel-title">
        {title}
      </h2>
    </header>
  );
}

export function VisibilityBadge({ visible, testId }: { visible: boolean; testId?: string }) {
  const copy = getMessages().site.sections;
  return (
    <p
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        visible ? "border-success/40 bg-success-soft text-success" : "text-muted border-dashed border-border"
      }`}
      data-testid={testId}
    >
      {visible ? copy.shown : copy.hidden}
    </p>
  );
}

function Thumb({ weddingId, photo, className = "" }: { weddingId: string; photo: EditorPhoto; className?: string }) {
  return (
    // Plain <img>: the member route's small rendition only (ADR-022).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photoSrc(memberPhotoBasePath(weddingId), photo.id, "640")}
      alt={photo.altText ?? getMessages().site.studio.canvas.missingAltImage}
      width={photo.width ?? undefined}
      height={photo.height ?? undefined}
      loading="lazy"
      decoding="async"
      className={`block aspect-[4/3] w-full rounded-md border border-border bg-background object-cover ${className}`}
      style={{ objectPosition: `${photo.focalX / 100}% ${photo.focalY / 100}%` }}
    />
  );
}

/** Save / discard for a draft, with the published-site consequence spelled out. */
function DraftActions({
  dirty,
  busy,
  saveLabel,
  savingLabel,
  onSave,
  onDiscard,
  isPublished,
  message,
  error,
}: {
  dirty: boolean;
  busy: boolean;
  saveLabel: string;
  savingLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  isPublished: boolean;
  message: string | null;
  error: string | null;
}) {
  const copy = getMessages().site.studio;
  return (
    <div className="space-y-3">
      {dirty ? <p className="rounded-lg border border-border bg-accent-soft px-3 py-2 text-sm">{copy.panel.unsaved}</p> : null}
      {dirty && isPublished ? <p className="text-sm font-semibold">{copy.publishedWarning}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSave} disabled={!dirty || busy} className={primaryButtonClass}>
          {busy ? savingLabel : saveLabel}
        </button>
        {dirty ? (
          <button type="button" onClick={onDiscard} disabled={busy} className={secondaryButtonClass}>
            {copy.panel.discard}
          </button>
        ) : null}
      </div>
      <p role="status" className="text-success min-h-5 text-sm font-medium" data-testid="studio-panel-status">
        {message}
      </p>
      {error ? (
        <p role="alert" className="text-danger text-sm font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ empty

export function EmptyPanel({ isPublished }: { isPublished: boolean }) {
  const copy = getMessages().site.studio;
  return (
    <div className="space-y-4 p-1" data-testid="studio-panel-empty">
      <div aria-hidden="true" className="mx-auto h-16 w-16 rounded-full border border-dashed border-accent/50 bg-accent-soft" />
      <h2 className="text-center font-serif text-2xl">{copy.panel.emptyTitle}</h2>
      <p className="text-muted text-center text-sm">{copy.panel.emptyBody}</p>
      <p className="text-muted text-center text-xs">{isPublished ? copy.publishedWarning : copy.unpublishedNote}</p>
    </div>
  );
}

// ---------------------------------------------------------------- section

export function SectionPanel({
  section,
  draft,
  onDraft,
  onDiscard,
  onSave,
  isPublished,
}: {
  section: EditorSection;
  draft: SectionDraft | undefined;
  onDraft: (next: SectionDraft) => void;
  onDiscard: () => void;
  onSave: () => Promise<SaveOutcome>;
  isPublished: boolean;
}) {
  const copy = getMessages().site;
  const id = useId();
  const value = draft ?? sectionDraftOf(section);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<Extract<SaveOutcome, { ok: false }> | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const result = await onSave();
    setBusy(false);
    if (result.ok) {
      setFailure(null);
      setMessage(result.message);
    } else setFailure(result);
  };

  return (
    <div className="space-y-5" data-testid="studio-panel" data-target={`section:${section.kind}`}>
      <PanelHeader
        eyebrow={`${copy.sections.textKind} · ${copy.kinds[section.kind]}`}
        title={sectionTitle(section.kind, value.title.trim() || null)}
        badge={<VisibilityBadge visible={section.isVisible} testId="site-section-visibility" />}
      />
      <p className="text-muted text-sm">{copy.studio.panel.fixedNote}</p>
      {section.kind === "rsvp" ? (
        <p className="text-muted text-sm">{interpolate(copy.sections.rsvpHint, { text: getMessages().publicSite.rsvpDefault })}</p>
      ) : null}
      <div className="space-y-1.5">
        <label htmlFor={`${id}-title`} className="block text-sm font-semibold">
          {copy.sections.titleLabel}
        </label>
        <input
          id={`${id}-title`}
          value={value.title}
          maxLength={SECTION_TITLE_MAX_LENGTH}
          autoComplete="off"
          aria-describedby={[`${id}-title-hint`, failure?.fieldErrors?.title ? `${id}-title-error` : null].filter(Boolean).join(" ")}
          aria-invalid={failure?.fieldErrors?.title ? true : undefined}
          onChange={(event) => onDraft({ ...value, title: event.target.value })}
          className={inputClass}
        />
        <p id={`${id}-title-hint`} className="text-muted text-xs">
          {interpolate(copy.sections.titleHint, { title: copy.defaultTitles[section.kind] })}
        </p>
        {failure?.fieldErrors?.title ? (
          <p id={`${id}-title-error`} className="text-danger text-sm">
            {failure.fieldErrors.title}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-body`} className="block text-sm font-semibold">
          {copy.sections.bodyLabel}
        </label>
        <textarea
          id={`${id}-body`}
          value={value.body}
          rows={8}
          maxLength={SECTION_BODY_MAX_LENGTH}
          aria-describedby={[`${id}-body-hint`, failure?.fieldErrors?.body ? `${id}-body-error` : null].filter(Boolean).join(" ")}
          aria-invalid={failure?.fieldErrors?.body ? true : undefined}
          onChange={(event) => onDraft({ ...value, body: event.target.value })}
          className={`${inputClass} min-h-40 leading-relaxed`}
        />
        <p id={`${id}-body-hint`} className="text-muted text-xs">
          {copy.sections.bodyHint}
        </p>
        {failure?.fieldErrors?.body ? (
          <p id={`${id}-body-error`} className="text-danger text-sm">
            {failure.fieldErrors.body}
          </p>
        ) : null}
      </div>
      <label className="flex min-h-11 items-center gap-3 font-semibold">
        <input
          type="checkbox"
          checked={value.isVisible}
          onChange={(event) => onDraft({ ...value, isVisible: event.target.checked })}
          className="h-5 w-5 accent-[var(--accent)]"
        />
        {copy.sections.visibleLabel}
      </label>
      {failure?.fieldErrors?.visible ? <p className="text-danger text-sm">{failure.fieldErrors.visible}</p> : null}
      <DraftActions
        dirty={draft !== undefined}
        busy={busy}
        saveLabel={copy.sections.submit}
        savingLabel={copy.sections.submitting}
        onSave={save}
        onDiscard={() => {
          setFailure(null);
          onDiscard();
        }}
        isPublished={isPublished}
        message={message}
        error={failure?.error ?? null}
      />
    </div>
  );
}

// ------------------------------------------------------------------ cover

export function CoverPanel({
  weddingId,
  header,
  isOwner,
  editor,
  act,
  setCover,
  setCoverVisible,
  removeCover,
}: {
  weddingId: string;
  header: SiteHeader;
  isOwner: boolean;
  editor: PhotoEditor | null;
  act: Act;
  setCover: (photoId: string) => Promise<Outcome>;
  setCoverVisible: (blockId: string, visible: boolean) => Promise<Outcome>;
  removeCover: (photoId: string) => Promise<Outcome>;
}) {
  const copy = getMessages().site;
  const studio = copy.studio.panel.cover;
  const cover = editor ? coverOf(editor) : null;
  const [confirming, setConfirming] = useState(false);
  const choices = editor ? libraryPhotos(editor).filter((photo) => photo.id !== cover?.photo?.id) : [];
  const library = editor ? libraryPhotos(editor) : [];
  return (
    <div className="space-y-5" data-testid="studio-panel" data-target="cover">
      <PanelHeader
        eyebrow={copy.studio.palette.fixedBadge}
        title={copy.studio.palette.cover}
        badge={cover?.block && cover.photo ? <VisibilityBadge visible={cover.block.isVisible} testId="studio-cover-visibility" /> : undefined}
      />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{getMessages().weddingSettings.nameLabel}</dt>
        <dd className="font-semibold break-words">{header.name}</dd>
        <dt className="text-muted">{getMessages().wedding.dateLabel}</dt>
        <dd className="font-semibold">{header.weddingDate ? formatWeddingDate(header.weddingDate) : copy.header.noDate}</dd>
        <dt className="text-muted">{getMessages().wedding.cityLabel}</dt>
        <dd className="font-semibold break-words">{header.city ?? copy.header.noCity}</dd>
      </dl>
      <p className="text-muted text-sm">
        {studio.headerNote}{" "}
        {isOwner ? (
          <a href={`/app/weddings/${encodeURIComponent(weddingId)}/settings`} className={textLinkClass}>
            {studio.settingsLink}
          </a>
        ) : null}
      </p>
      {editor ? (
        <section className="space-y-3 border-t border-border pt-4" aria-labelledby="studio-cover-photo">
          <h3 id="studio-cover-photo" className="font-semibold">
            {studio.photo}
          </h3>
          {cover?.block && cover.photo ? (
            <div className="space-y-3">
              <Thumb weddingId={weddingId} photo={cover.photo} />
              {cover.photo.altText ? null : <p className="text-sm font-semibold">{copy.photos.library.missingAlt}</p>}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`${secondaryButtonClass} ${small}`}
                  onClick={() => act(() => setCoverVisible(cover.block!.id, !cover.block!.isVisible))}
                >
                  {cover.block.isVisible ? copy.compose.hide : copy.compose.show}
                </button>
                {confirming ? (
                  <>
                    <span className="self-center text-sm">{studio.removeConfirm}</span>
                    <button
                      type="button"
                      className={`${secondaryButtonClass} ${small} text-danger`}
                      onClick={async () => {
                        setConfirming(false);
                        await act(() => removeCover(cover.photo!.id));
                      }}
                    >
                      {studio.removeYes}
                    </button>
                    <button type="button" className={`${secondaryButtonClass} ${small}`} onClick={() => setConfirming(false)}>
                      {copy.photos.cover.cancel}
                    </button>
                  </>
                ) : (
                  <button type="button" className={`${secondaryButtonClass} ${small}`} onClick={() => setConfirming(true)}>
                    {copy.photos.cover.remove}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-muted text-sm">{studio.noPhoto}</p>
          )}
          <h4 className="pt-2 text-sm font-semibold">{cover?.photo ? studio.change : studio.choose}</h4>
          {choices.length === 0 ? (
            <p className="text-muted text-sm">{copy.studio.panel.block.pickEmpty}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2" data-testid="studio-cover-choices">
              {choices.map((photo) => (
                <li key={photo.id}>
                  <button
                    type="button"
                    onClick={() => act(() => setCover(photo.id))}
                    aria-label={interpolate(copy.compose.cover.useLabel, { position: String(library.indexOf(photo) + 1) })}
                    className="block w-full rounded-md hover:outline-2 hover:outline-accent focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <Thumb weddingId={weddingId} photo={photo} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Upload weddingId={weddingId} editor={editor} />
        </section>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ block

export function BlockPanel({
  weddingId,
  editor,
  block,
  name,
  draft,
  onDraft,
  onDiscard,
  onSave,
  act,
  isPublished,
  actions,
  reorderDisabled = false,
}: {
  weddingId: string;
  editor: PhotoEditor;
  block: EditorBlock;
  name: string;
  draft: BlockDraft | undefined;
  onDraft: (next: BlockDraft) => void;
  onDiscard: () => void;
  onSave: () => Promise<SaveOutcome>;
  act: Act;
  isPublished: boolean;
  reorderDisabled?: boolean;
  actions: Readonly<{
    addPhotos: (photoIds: readonly string[]) => Promise<Outcome>;
    removePhoto: (photoId: string) => Promise<Outcome>;
    movePhoto: (photoId: string, direction: "before" | "after", label: string) => Promise<Outcome>;
    moveBlock: (direction: "before" | "after") => Promise<Outcome>;
    describePhoto: (photo: EditorPhoto, altText: string, caption: string) => Promise<Outcome>;
    deleteBlock: () => Promise<Outcome>;
  }>;
}) {
  const copy = getMessages().site;
  const studio = copy.studio.panel.block;
  const blocks = copy.photos.blocks;
  const id = useId();
  const value = draft ?? blockDraftOf(block);
  const photos = photosIn(editor, block.id);
  const siblings = slotSiblings(editor, block);
  const place = siblings.findIndex((other) => other.id === block.id);
  const variants = PHOTO_BLOCK_VARIANTS[block.kind];
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const result = await onSave();
    setBusy(false);
    if (result.ok) {
      setError(null);
      setMessage(result.message);
    } else setError(result.error ?? copy.studio.panel.failed);
  };

  return (
    <div className="space-y-5" data-testid="studio-panel" data-target={`block:${block.id}`} data-block-kind={block.kind}>
      <PanelHeader
        eyebrow={`${copy.compose.photoKind} · ${blocks.kinds[block.kind]}`}
        title={name}
        badge={<VisibilityBadge visible={block.isVisible} testId="studio-block-visibility" />}
      />

      {/* Photos first: what a new section needs next. */}
      <section className="space-y-3" aria-labelledby={`${id}-photos`}>
        <h3 id={`${id}-photos`} className="font-semibold">
          {studio.photosTitle}
        </h3>
        {photos.length === 0 ? (
          <p className="rounded-lg border border-dashed border-accent/60 bg-accent-soft px-3 py-2 text-sm font-semibold" data-testid="studio-choose-photos">
            {studio.choosePrompt}
          </p>
        ) : (
          <ol className="space-y-2" data-testid="studio-block-photos">
            {photos.map((photo, index) => (
              <BlockPhoto
                key={photo.id}
                weddingId={weddingId}
                photo={photo}
                position={index + 1}
                total={photos.length}
                act={act}
                actions={actions}
              />
            ))}
          </ol>
        )}
        <PhotoPicker weddingId={weddingId} editor={editor} block={block} act={act} addPhotos={actions.addPhotos} />
        <Upload weddingId={weddingId} editor={editor} />
      </section>

      <section className="space-y-4 border-t border-border pt-4" aria-labelledby={`${id}-settings`}>
        <h3 id={`${id}-settings`} className="sr-only">
          {name}
        </h3>
        <label className="flex min-h-11 items-center gap-3 font-semibold">
          <input
            type="checkbox"
            checked={value.isVisible}
            onChange={(event) => onDraft({ ...value, isVisible: event.target.checked })}
            className="h-5 w-5 accent-[var(--accent)]"
          />
          {blocks.visibleLabel}
        </label>
        {variants.length > 1 ? (
          <div className="space-y-1.5">
            <label htmlFor={`${id}-variant`} className="block text-sm font-semibold">
              {blocks.variantLabel}
            </label>
            <select
              id={`${id}-variant`}
              value={value.variant}
              onChange={(event) => onDraft({ ...value, variant: event.target.value as PhotoBlockVariant })}
              className={inputClass}
            >
              {variants.map((variant) => (
                <option key={variant} value={variant}>
                  {blocks.variants[variant]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor={`${id}-anchor`} className="block text-sm font-semibold">
            {blocks.anchorLabel}
          </label>
          <select
            id={`${id}-anchor`}
            value={value.anchor ?? "top"}
            onChange={(event) =>
              onDraft({ ...value, anchor: event.target.value === "top" ? null : (event.target.value as SectionKind) })
            }
            className={inputClass}
          >
            <option value="top">{blocks.anchorTop}</option>
            {SECTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {interpolate(blocks.anchorAfter, { section: sectionTitle(kind, null) })}
              </option>
            ))}
          </select>
        </div>
        {block.kind === "photo_text" ? (
          <>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-title`} className="block text-sm font-semibold">
                {blocks.titleLabel}
              </label>
              <input
                id={`${id}-title`}
                value={value.title}
                maxLength={PHOTO_LIMITS.blockTitleMax}
                onChange={(event) => onDraft({ ...value, title: event.target.value })}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-body`} className="block text-sm font-semibold">
                {blocks.bodyLabel}
              </label>
              <textarea
                id={`${id}-body`}
                value={value.body}
                rows={5}
                maxLength={PHOTO_LIMITS.blockBodyMax}
                onChange={(event) => onDraft({ ...value, body: event.target.value })}
                className={inputClass}
              />
            </div>
          </>
        ) : null}
        <DraftActions
          dirty={draft !== undefined}
          busy={busy}
          saveLabel={blocks.save}
          savingLabel={blocks.saving}
          onSave={save}
          onDiscard={() => {
            setError(null);
            onDiscard();
          }}
          isPublished={isPublished}
          message={message}
          error={error}
        />
      </section>

      {siblings.length > 1 ? (
        <section className="space-y-2 border-t border-border pt-4" aria-labelledby={`${id}-slot`}>
          <h3 id={`${id}-slot`} className="text-sm font-semibold">
            {studio.slotTitle}
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={reorderDisabled || place <= 0}
              className={`${secondaryButtonClass} ${small}`}
              onClick={() => act(() => actions.moveBlock("before"))}
            >
              {studio.moveBefore}
            </button>
            <button
              type="button"
              disabled={reorderDisabled || place >= siblings.length - 1}
              className={`${secondaryButtonClass} ${small}`}
              onClick={() => act(() => actions.moveBlock("after"))}
            >
              {studio.moveAfter}
            </button>
          </div>
        </section>
      ) : null}

      <div className="border-t border-border pt-4">
        {confirmDelete ? (
          <div className="space-y-2">
            <p className="text-sm">{studio.deleteConfirm}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={`${secondaryButtonClass} ${small} text-danger`}
                onClick={async () => {
                  setConfirmDelete(false);
                  await act(actions.deleteBlock);
                }}
              >
                {studio.deleteYes}
              </button>
              <button type="button" className={`${secondaryButtonClass} ${small}`} onClick={() => setConfirmDelete(false)}>
                {blocks.cancel}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={`${secondaryButtonClass} ${small} text-danger`} onClick={() => setConfirmDelete(true)}>
            {studio.delete}
          </button>
        )}
      </div>
    </div>
  );
}

function BlockPhoto({
  weddingId,
  photo,
  position,
  total,
  act,
  actions,
}: {
  weddingId: string;
  photo: EditorPhoto;
  position: number;
  total: number;
  act: Act;
  actions: Readonly<{
    removePhoto: (photoId: string) => Promise<Outcome>;
    movePhoto: (photoId: string, direction: "before" | "after", label: string) => Promise<Outcome>;
    describePhoto: (photo: EditorPhoto, altText: string, caption: string) => Promise<Outcome>;
  }>;
}) {
  const copy = getMessages().site;
  const studio = copy.studio.panel.block;
  const id = useId();
  const [alt, setAlt] = useState(photo.altText ?? "");
  const [caption, setCaption] = useState(photo.caption ?? "");
  const vars = { position: String(position) };
  const label = interpolate(copy.photos.blocks.photoName, vars);
  return (
    <li className="space-y-2 rounded-lg border border-border bg-surface p-2" data-testid="studio-block-photo">
      <div className="flex gap-3">
        <div className="w-20 shrink-0">
          <Thumb weddingId={weddingId} photo={photo} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-semibold">
            {label}
            {photo.altText ? null : <span className="text-muted ml-2 text-xs font-normal">· {studio.photoMissingAlt}</span>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={position === 1}
              aria-label={interpolate(studio.upLabel, vars)}
              className={`${secondaryButtonClass} min-h-8 px-2.5 py-1 text-xs`}
              onClick={() => act(() => actions.movePhoto(photo.id, "before", label))}
            >
              {studio.up}
            </button>
            <button
              type="button"
              disabled={position === total}
              aria-label={interpolate(studio.downLabel, vars)}
              className={`${secondaryButtonClass} min-h-8 px-2.5 py-1 text-xs`}
              onClick={() => act(() => actions.movePhoto(photo.id, "after", label))}
            >
              {studio.down}
            </button>
            <button
              type="button"
              aria-label={interpolate(studio.removeLabel, vars)}
              className={`${secondaryButtonClass} min-h-8 px-2.5 py-1 text-xs`}
              onClick={() => act(() => actions.removePhoto(photo.id))}
            >
              {studio.remove}
            </button>
          </div>
        </div>
      </div>
      <details open={!photo.altText} className="group">
        <summary className="cursor-pointer text-xs font-semibold" aria-label={interpolate(studio.describeLabel, vars)}>
          {studio.describe}
        </summary>
        <div className="mt-2 space-y-2">
          <label htmlFor={`${id}-alt`} className="block text-xs font-semibold">
            {copy.photos.library.altLabel}
          </label>
          <textarea
            id={`${id}-alt`}
            rows={2}
            value={alt}
            maxLength={PHOTO_LIMITS.altTextMax}
            onChange={(event) => setAlt(event.target.value)}
            className={`${inputClass} text-sm`}
          />
          <label htmlFor={`${id}-caption`} className="block text-xs font-semibold">
            {copy.photos.library.captionLabel}
          </label>
          <input
            id={`${id}-caption`}
            value={caption}
            maxLength={PHOTO_LIMITS.captionMax}
            onChange={(event) => setCaption(event.target.value)}
            className={`${inputClass} text-sm`}
          />
          <button
            type="button"
            className={`${secondaryButtonClass} min-h-8 px-3 py-1 text-xs`}
            onClick={() => act(() => actions.describePhoto(photo, alt, caption))}
          >
            {copy.photos.library.save}
          </button>
        </div>
      </details>
    </li>
  );
}

/** The library, inline: tick photos, then add them all at once (one action per photo, the same checks). */
function PhotoPicker({
  weddingId,
  editor,
  block,
  act,
  addPhotos,
}: {
  weddingId: string;
  editor: PhotoEditor;
  block: EditorBlock;
  act: Act;
  addPhotos: (photoIds: readonly string[]) => Promise<Outcome>;
}) {
  const studio = getMessages().site.studio.panel.block;
  const library = libraryPhotos(editor);
  const choices = photosForBlock(editor, block);
  const single = SINGLE_PHOTO_KINDS.includes(block.kind);
  const room = blockHasRoom(editor, block);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const valid = chosen.filter((photoId) => choices.some((photo) => photo.id === photoId));

  if (library.length === 0) return <p className="text-muted text-sm">{studio.pickEmpty}</p>;
  if (!room) return <p className="text-muted text-sm">{studio.pickOne}</p>;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-testid="studio-photo-picker">
      <legend className="px-1 text-sm font-semibold">{studio.pickTitle}</legend>
      <p className="text-muted text-xs">{single ? studio.pickOne : studio.pickHint}</p>
      {choices.length === 0 ? (
        <p className="text-muted text-sm">{studio.pickNone}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {choices.map((photo) => {
            const position = library.indexOf(photo) + 1;
            const checked = valid.includes(photo.id);
            const placed = photo.blockId ? editor.blocks.find((other) => other.id === photo.blockId) : null;
            return (
              <li key={photo.id}>
                <label className={`block cursor-pointer rounded-md p-0.5 ${checked ? "outline-2 outline-accent" : ""}`}>
                  <input
                    type={single ? "radio" : "checkbox"}
                    name={`pick-${block.id}`}
                    checked={checked}
                    onChange={(event) =>
                      setChosen(single ? [photo.id] : event.target.checked ? [...valid, photo.id] : valid.filter((x) => x !== photo.id))
                    }
                    className="sr-only"
                    aria-label={`${getMessages().site.photos.library.photoName.replace("{position}", String(position))}${
                      photo.altText ? `: ${photo.altText}` : ""
                    }${placed ? ` (${interpolate(studio.inOther, { place: getMessages().site.photos.blocks.kinds[placed.kind] })})` : ""}`}
                  />
                  <Thumb weddingId={weddingId} photo={photo} />
                  <span className="mt-0.5 block truncate text-[11px]">
                    {photo.altText ? null : studio.photoMissingAlt}
                    {placed ? interpolate(studio.inOther, { place: getMessages().site.photos.blocks.kinds[placed.kind] }) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        disabled={valid.length === 0}
        className={`${primaryButtonClass} ${small} w-full`}
        onClick={async () => {
          const ok = await act(() => addPhotos(valid));
          if (ok) setChosen([]);
        }}
      >
        {valid.length <= 1 ? studio.addOne : interpolate(studio.addMany, { count: String(valid.length) })}
      </button>
    </fieldset>
  );
}

/** "Subir fotos nuevas": the existing secure uploader, folded away. */
function Upload({ weddingId, editor }: { weddingId: string; editor: PhotoEditor }) {
  const studio = getMessages().site.studio;
  const remaining = Math.max(0, PHOTO_LIMITS.photosPerWedding - editor.photos.length);
  // Open at first when the library is empty; then it stays as the person left it (uploads refresh the page).
  const [open, setOpen] = useState(() => libraryPhotos(editor).length === 0);
  return (
    <details
      className="rounded-lg border border-border px-3 py-2"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold">{studio.panel.block.uploadTitle}</summary>
      <div className="mt-3">
        <PhotoUploader weddingId={weddingId} remaining={remaining} />
      </div>
    </details>
  );
}

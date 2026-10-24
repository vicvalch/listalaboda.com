"use client";

import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { reorderRequest, type ReorderRequest } from "@/lib/wedding-site/studio-reorder";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages, interpolate } from "@/lib/i18n";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { SitePhotoBlock } from "@/lib/wedding-site/photos/model";
import { sectionTitle, type PublishedWeddingSite, type SectionKind } from "@/lib/wedding-site/sections";
import { sameTarget, targetKey, type InsertableElement, type StudioTarget } from "@/lib/wedding-site/studio";

import { ElementIcon } from "./icons";

export type CanvasBlockInfo = Readonly<{ id: string; name: string; missingAlt: number }>;

/**
 * What the canvas draws (STUDIO-01): the REAL public renderer, `WeddingSite`,
 * with the couple's saved content and unsaved drafts, and Studio's
 * `studio` hooks around each element: a quiet outline on hover, a clear one
 * when selected, an "Oculta" chip on what guests won't see, placeholders for
 * empty sections, and "Agregar … aquí" only while adding an element. Links
 * inside never navigate (the canvas is not the public page).
 */
export function StudioCanvas({
  site,
  design,
  blocks,
  basePath,
  blockInfo,
  hiddenSections,
  emptySections,
  coverHidden,
  unsaved,
  selected,
  onSelect,
  inserting,
  onInsert,
  insertBusy,
  editor,
  onReorder,
  reorderDisabled,
}: {
  site: PublishedWeddingSite;
  design: ResolvedSiteDesign;
  blocks: readonly SitePhotoBlock[];
  basePath: string;
  blockInfo: ReadonlyMap<SitePhotoBlock, CanvasBlockInfo>;
  hiddenSections: ReadonlySet<SectionKind>;
  emptySections: ReadonlySet<SectionKind>;
  coverHidden: boolean;
  unsaved: ReadonlySet<string>;
  selected: StudioTarget | null;
  onSelect: (target: StudioTarget) => void;
  inserting: InsertableElement | null;
  onInsert: (anchor: SectionKind | null) => void;
  insertBusy: boolean;
  editor: PhotoEditor | null;
  onReorder: (request: ReorderRequest) => void;
  reorderDisabled: boolean;
}) {
  const copy = getMessages().site.studio;
  const root = useRef<HTMLDivElement>(null);
  const snapshot = useRef<PhotoEditor | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }));
  const dragDisabled = reorderDisabled || insertBusy || inserting !== null;
  const activeAnchor = editor?.blocks.find((b) => b.id === dragging)?.anchor;
  const movable = (id: string, name: string, node: ReactNode) => {
    const block = editor?.blocks.find((b) => b.id === id && b.kind !== "cover");
    return block ? <MovableBlock id={id} name={name} anchor={block.anchor} disabled={dragDisabled}
      eligible={dragging !== null && activeAnchor === block.anchor}>{node}</MovableBlock> : node;
  };

  // Bring the selected element into view (inside the iframe).
  useEffect(() => {
    if (!selected) return;
    const node = root.current?.querySelector(`[data-studio-target="${targetKey(selected)}"]`);
    const reduce = root.current?.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [selected]);

  // Links in the canvas never leave Studio; in-page carousel links still scroll.
  const keepInStudio = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.("a");
    if (link && !(link.getAttribute("href") ?? "").startsWith("#")) event.preventDefault();
  };

  const target = (key: StudioTarget, name: string, hidden: boolean, node: ReactNode, note?: string) => (
    <Target
      target={key}
      name={name}
      hidden={hidden}
      unsaved={unsaved.has(targetKey(key))}
      selected={sameTarget(selected, key)}
      onSelect={onSelect}
      note={note}
    >
      {node}
    </Target>
  );

  const element = inserting ? copy.palette.elements[inserting].name : "";

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
      accessibility={{ screenReaderInstructions: { draggable: copy.reorder.instructions } }}
      onDragStart={({ active }) => {
        snapshot.current = editor;
        setDragging(String(active.id));
      }}
      onDragCancel={() => { snapshot.current = null; setDragging(null); }}
      onDragEnd={({ active, over }) => {
        const saved = snapshot.current;
        snapshot.current = null;
        setDragging(null);
        if (dragDisabled || !saved || !over) return;
        const zone = over.data.current as { anchor: SectionKind | null; beforeId: string | null } | undefined;
        if (!zone) return;
        const request = reorderRequest(saved, String(active.id), zone.anchor, zone.beforeId);
        if (request) onReorder(request);
      }}>
    <div ref={root} onClickCapture={keepInStudio} className="flex min-h-full flex-1 flex-col" data-testid="studio-canvas-root">
      <WeddingSite
        site={site}
        design={design}
        element="div"
        photos={{ blocks, basePath }}
        studio={{
          hero: (node) => target({ type: "cover" }, copy.palette.cover, coverHidden, node),
          section: (kind, node) => {
            const key: StudioTarget = { type: "section", kind };
            const name = getMessages().site.kinds[kind];
            if (node === null || emptySections.has(kind)) {
              return (
                <Placeholder
                  target={key}
                  icon="text"
                  title={sectionTitle(kind, null)}
                  text={copy.canvas.empty}
                  hint={copy.canvas.emptyHint}
                  selected={sameTarget(selected, key)}
                  unsaved={unsaved.has(targetKey(key))}
                  onSelect={onSelect}
                />
              );
            }
            return target(key, name, hiddenSections.has(kind), node);
          },
          block: (block, node) => {
            const info = blockInfo.get(block);
            if (!info) return node;
            const key: StudioTarget = { type: "block", id: info.id };
            if (block.photos.length === 0) {
              return (
                movable(info.id, info.name, <Placeholder
                  target={key}
                  icon={block.kind === "cover" ? "cover" : block.kind}
                  title={info.name}
                  text={copy.canvas.emptyBlock}
                  hint={copy.canvas.emptyBlockHint}
                  selected={sameTarget(selected, key)}
                  unsaved={unsaved.has(targetKey(key))}
                  onSelect={onSelect}
                  hidden={block.hidden}
                />)
              );
            }
            const note = info.missingAlt > 0 ? interpolate(copy.canvas.missingAlt, { count: String(info.missingAlt) }) : undefined;
            return movable(info.id, info.name, target(key, info.name, block.hidden, node, note));
          },
          slotEnd: (anchor) =>
            inserting ? (
              <InsertButton
                element={element}
                where={
                  anchor === null
                    ? copy.insert.atTop
                    : interpolate(copy.insert.after, { section: sectionTitle(anchor, null) })
                }
                anchor={anchor}
                onInsert={onInsert}
                busy={insertBusy}
              />
            ) : <SlotEnd anchor={anchor} active={dragging !== null && activeAnchor === anchor} />,
        }}
      />
    </div>
    <DragOverlay dropAnimation={null}>{dragging ? <div className="rounded border border-accent bg-surface px-3 py-2 text-sm">{copy.reorder.moving}</div> : null}</DragOverlay>
    </DndContext>
  );
}

const CHIP = "rounded-full border px-2.5 py-0.5 text-xs font-semibold shadow-sm";

function Target({
  target,
  name,
  hidden,
  unsaved,
  selected,
  onSelect,
  note,
  children,
}: {
  target: StudioTarget;
  name: string;
  hidden: boolean;
  unsaved: boolean;
  selected: boolean;
  onSelect: (target: StudioTarget) => void;
  note?: string;
  children: ReactNode;
}) {
  const copy = getMessages().site.studio.canvas;
  const flagged = selected || hidden || unsaved;
  return (
    <div
      data-studio-target={targetKey(target)}
      data-selected={selected ? "" : undefined}
      data-hidden={hidden ? "" : undefined}
      onClick={() => onSelect(target)}
      className={`group/target relative cursor-pointer rounded-md outline-offset-[10px] ${
        selected
          ? "outline-2 outline-accent"
          : hidden
            ? "outline-1 outline-dashed outline-border hover:outline-accent/60"
            : "hover:outline-1 hover:outline-dashed hover:outline-accent/60"
      }`}
    >
      <div className="absolute -top-[22px] left-0 z-10 flex flex-wrap gap-1">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={interpolate(copy.select, { name })}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(target);
          }}
          className={`${CHIP} border-accent bg-accent text-accent-foreground focus-visible:opacity-100 ${
            flagged ? "opacity-100" : "opacity-0 group-hover/target:opacity-100"
          }`}
        >
          {name}
        </button>
        {hidden ? <span className={`${CHIP} border-dashed border-border bg-surface`}>{copy.hidden}</span> : null}
        {unsaved ? <span className={`${CHIP} border-border bg-surface`}>{copy.unsaved}</span> : null}
        {note ? <span className={`${CHIP} border-border bg-surface`}>{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Placeholder({
  target,
  icon,
  title,
  text,
  hint,
  selected,
  unsaved,
  hidden = true,
  onSelect,
}: {
  target: StudioTarget;
  icon: InsertableElement | "cover" | "text";
  title: string;
  text: string;
  hint: string;
  selected: boolean;
  unsaved: boolean;
  hidden?: boolean;
  onSelect: (target: StudioTarget) => void;
}) {
  const copy = getMessages().site.studio.canvas;
  return (
    <div data-studio-target={targetKey(target)} data-selected={selected ? "" : undefined} data-hidden={hidden ? "" : undefined}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(target)}
        className={`text-muted flex w-full items-center gap-3 rounded-xl border border-dashed bg-surface/60 px-4 py-3 text-left text-sm ${
          selected ? "border-accent outline-2 outline-offset-4 outline-accent" : "border-border hover:border-accent"
        }`}
      >
        <ElementIcon kind={icon} className="h-5 w-5 shrink-0" />
        <span className="min-w-0">
          <span className="text-foreground font-semibold">{title}</span> · {text}
          <span className="block text-xs">{hint}</span>
        </span>
        {hidden ? <span className={`${CHIP} ml-auto border-dashed border-border bg-surface`}>{copy.hidden}</span> : null}
        {unsaved ? <span className={`${CHIP} border-border bg-surface`}>{copy.unsaved}</span> : null}
      </button>
    </div>
  );
}

function InsertButton({
  element,
  where,
  anchor,
  onInsert,
  busy,
}: {
  element: string;
  where: string;
  anchor: SectionKind | null;
  onInsert: (anchor: SectionKind | null) => void;
  busy: boolean;
}) {
  const copy = getMessages().site.studio.insert;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onInsert(anchor)}
      aria-label={interpolate(copy.hereLabel, { element, where })}
      data-testid="studio-insert"
      data-anchor={anchor ?? "top"}
      className="w-full rounded-xl border-2 border-dashed border-accent bg-accent-soft px-4 py-3 text-sm font-semibold text-accent hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
    >
      <span aria-hidden="true">＋ </span>
      {interpolate(copy.here, { element })}
      <span className="sr-only"> {where}</span>
    </button>
  );
}

/** Both the sensor and its targets live in the iframe; no cross-document palette drag. */
function MovableBlock({ id, name, anchor, disabled, eligible, children }: {
  id: string; name: string; anchor: SectionKind | null; disabled: boolean; eligible: boolean; children: ReactNode;
}) {
  const drag = useDraggable({ id, disabled });
  const drop = useDroppable({ id: `before:${id}`, data: { anchor, beforeId: id }, disabled: !eligible });
  const copy = getMessages().site.studio.reorder;
  return <div ref={drop.setNodeRef} data-reorder-block={id} className={`relative ${drop.isOver ? "outline-2 outline-accent" : ""}`}>
    <button type="button" ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners}
      disabled={disabled} aria-label={interpolate(copy.handle, { name })} data-testid="studio-drag-handle"
      className="mb-7 cursor-grab touch-none rounded border border-border bg-surface px-3 py-2 text-sm active:cursor-grabbing disabled:opacity-50">
      {copy.handleText}
    </button>
    {children}
  </div>;
}

function SlotEnd({ anchor, active }: { anchor: SectionKind | null; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `end:${anchor ?? "top"}`, data: { anchor, beforeId: null }, disabled: !active });
  return <div ref={setNodeRef} data-reorder-end={anchor ?? "top"} className={active ? `min-h-12 border-2 border-dashed ${isOver ? "border-accent bg-accent-soft" : "border-border"}` : "h-1"}>
    {active ? <span className="text-sm">{getMessages().site.studio.reorder.slotEnd}</span> : null}
  </div>;
}

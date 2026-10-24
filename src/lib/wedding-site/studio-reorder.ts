import { orderedBlocks, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import type { SectionKind } from "@/lib/wedding-site/sections";

export type ReorderRequest = Readonly<{
  blockId: string;
  anchor: SectionKind | null;
  beforeId: string | null;
  order: readonly string[];
}>;

/** Captured at drag start, not reconstructed from possibly refreshed data on drop. */
export function slotOrder(editor: PhotoEditor, blockId: string): string[] {
  const block = editor.blocks.find((b) => b.id === blockId && b.kind !== "cover");
  return block ? orderedBlocks(editor).filter((b) => b.anchor === block.anchor).map((b) => b.id) : [];
}

/** Null means invalid, cross-slot or no-op: callers must not send a write. */
export function reorderRequest(editor: PhotoEditor, blockId: string, anchor: SectionKind | null, beforeId: string | null): ReorderRequest | null {
  const block = editor.blocks.find((b) => b.id === blockId && b.kind !== "cover");
  if (!block || block.anchor !== anchor) return null;
  const order = slotOrder(editor, blockId);
  if (beforeId !== null && !order.includes(beforeId)) return null;
  const index = order.indexOf(blockId);
  if (beforeId === blockId || beforeId === (order[index + 1] ?? null)) return null;
  return { blockId, anchor, beforeId, order };
}

export function adjacentRequest(editor: PhotoEditor, blockId: string, direction: "before" | "after"): ReorderRequest | null {
  const block = editor.blocks.find((b) => b.id === blockId && b.kind !== "cover");
  if (!block) return null;
  const order = slotOrder(editor, blockId);
  const index = order.indexOf(blockId);
  if ((direction === "before" && index === 0) || (direction === "after" && index === order.length - 1)) return null;
  return reorderRequest(editor, blockId, block.anchor, direction === "before" ? order[index - 1]! : order[index + 2] ?? null);
}

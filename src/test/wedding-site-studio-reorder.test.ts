import { describe, expect, it } from "vitest";
import type { EditorBlock, PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { adjacentRequest, reorderRequest, slotOrder } from "@/lib/wedding-site/studio-reorder";

const block = (id: string, position: number, anchor: EditorBlock["anchor"] = "intro", kind: EditorBlock["kind"] = "gallery"): EditorBlock =>
  ({ id, position, anchor, kind, variant: "grid", isVisible: false, title: null, body: null });
const editor: PhotoEditor = { blocks: [block("a", 0), block("b", 1), block("c", 2), block("other", 3, "faq"), block("cover", 4, null, "cover")], photos: [] };

describe("same-slot reorder intent", () => {
  it("captures the expected order and a non-adjacent destination without mutating the editor", () => {
    const snapshot = structuredClone(editor);
    expect(reorderRequest(editor, "c", "intro", "a")).toEqual({ blockId: "c", anchor: "intro", beforeId: "a", order: ["a", "b", "c"] });
    expect(editor).toEqual(snapshot);
    expect(slotOrder(editor, "cover")).toEqual([]);
  });
  it("rejects self, next-neighbor and already-last no-ops", () => {
    expect(reorderRequest(editor, "a", "intro", "a")).toBeNull();
    expect(reorderRequest(editor, "a", "intro", "b")).toBeNull();
    expect(reorderRequest(editor, "c", "intro", null)).toBeNull();
  });
  it("rejects foreign slots, covers and missing targets", () => {
    expect(reorderRequest(editor, "a", "faq", "other")).toBeNull();
    expect(reorderRequest(editor, "a", "intro", "other")).toBeNull();
    expect(reorderRequest(editor, "cover", null, null)).toBeNull();
    expect(reorderRequest(editor, "missing", "intro", "a")).toBeNull();
  });
  it("maps keyboard/tap alternatives to the same atomic request and never crosses slot edges", () => {
    expect(adjacentRequest(editor, "a", "before")).toBeNull();
    expect(adjacentRequest(editor, "c", "after")).toBeNull();
    expect(adjacentRequest(editor, "b", "before")?.beforeId).toBe("a");
    expect(adjacentRequest(editor, "a", "after")?.beforeId).toBe("c");
  });
});

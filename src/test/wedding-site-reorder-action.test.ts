import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), membership: vi.fn(), reorder: vi.fn(), read: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/authz/wedding", () => ({ requireWeddingMembership: mocks.membership }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@/lib/wedding-site/photos/service", () => ({ reorderPhotoBlock: mocks.reorder, getPhotoEditor: mocks.read }));
const { reorderBlockAction } = await import("@/app/app/weddings/[weddingId]/site/studio/reorder-actions");
const request = { blockId: "a", anchor: null, beforeId: null, order: ["a", "b"] };
const editor = { blocks: [], photos: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue({ ok: true, access: { weddingId: "w" } });
  mocks.reorder.mockResolvedValue({ ok: true, value: ["b", "a"] });
  mocks.read.mockResolvedValue(editor);
});
describe("reorder reconciliation", () => {
  it("returns authoritative editor data after a successful write", async () => {
    expect(await reorderBlockAction("w", request)).toEqual({ ok: true, editor });
    expect(mocks.requireUser).toHaveBeenCalled();
    expect(mocks.reorder).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalled();
  });
  it.each(["refused", "ambiguous"])("rereads after %s persistence without replaying the write", async (failure) => {
    if (failure === "refused") mocks.reorder.mockResolvedValue({ ok: false, reason: "error" });
    else mocks.reorder.mockRejectedValue(new Error("connection lost"));
    expect(await reorderBlockAction("w", request)).toEqual({ ok: false, editor });
    expect(mocks.reorder).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("signals unavailable state instead of inventing rollback", async () => {
    mocks.read.mockRejectedValue(new Error("offline"));
    expect(await reorderBlockAction("w", request)).toEqual({ ok: false, editor: null });
  });
  it("never writes or reads photo data for a nonmember", async () => {
    mocks.membership.mockResolvedValue({ ok: false });
    expect(await reorderBlockAction("w", request)).toEqual({ ok: false, editor: null });
    expect(mocks.reorder).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

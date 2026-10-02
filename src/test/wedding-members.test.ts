import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import {
  assigneeLabel,
  compareMembers,
  labelMembers,
  type WeddingMember,
} from "@/lib/weddings/members";
import { DISPLAY_NAME_MAX_LENGTH, parseDisplayName } from "@/lib/weddings/validation";

function member(
  membershipId: string,
  role: WeddingMember["role"],
  options: Partial<Omit<WeddingMember, "membershipId" | "role">> = {},
): WeddingMember {
  return {
    membershipId,
    role,
    displayName: null,
    isCurrentUser: false,
    joinedAt: "2026-10-01T10:00:00.000Z",
    ...options,
  };
}

const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("labelMembers", () => {
  it("calls the current member «Tú», with their name only in the picker", () => {
    const [unnamed] = labelMembers([member("m1", "owner", { isCurrentUser: true })]);
    expect(unnamed).toMatchObject({ label: "Tú", optionLabel: "Tú" });

    const [named] = labelMembers([
      member("m1", "collaborator", { isCurrentUser: true, displayName: "Victor" }),
    ]);
    expect(named).toMatchObject({ label: "Tú", optionLabel: "Tú (Victor)" });
  });

  it("uses another member's own name", () => {
    const labeled = labelMembers([
      member("me", "owner", { isCurrentUser: true }),
      member("m2", "collaborator", { displayName: "Sofía" }),
    ]);
    expect(labeled[1]).toMatchObject({ label: "Sofía", optionLabel: "Sofía" });
  });

  it("falls back to a neutral role label for unnamed members", () => {
    const labeled = labelMembers([
      member("me", "collaborator", { isCurrentUser: true }),
      member("o1", "owner"),
      member("c1", "collaborator"),
    ]);
    expect(labeled.map((m) => m.label)).toEqual([
      "Tú",
      es.members.fallback.owner,
      es.members.fallback.collaborator,
    ]);
  });

  it("numbers several unnamed members of the same role, in join order", () => {
    const labeled = labelMembers([
      member("c-late", "collaborator", { joinedAt: at(30) }),
      member("me", "owner", { isCurrentUser: true }),
      member("c-named", "collaborator", { joinedAt: at(5), displayName: "Mamá" }),
      member("c-early", "collaborator", { joinedAt: at(10) }),
    ]);
    expect(labeled.map((m) => [m.membershipId, m.label])).toEqual([
      ["me", "Tú"],
      ["c-named", "Mamá"],
      ["c-early", "Persona colaboradora 1"],
      ["c-late", "Persona colaboradora 2"],
    ]);
  });

  it("never shows ids or other internals as a label", () => {
    const labeled = labelMembers([
      member("11111111-1111-4111-8111-111111111111", "owner"),
      member("22222222-2222-4222-8222-222222222222", "collaborator"),
    ]);
    for (const m of labeled) {
      expect(m.label).not.toContain(m.membershipId);
      expect(m.optionLabel).not.toMatch(/[0-9a-f]{8}-/);
    }
  });
});

describe("member order", () => {
  it("is you, then owners, then collaborators; join time, then id, breaks ties", () => {
    const members = [
      member("c2", "collaborator", { joinedAt: at(1) }),
      member("o2", "owner", { joinedAt: at(5) }),
      member("c1", "collaborator", { joinedAt: at(1) }),
      member("me", "collaborator", { isCurrentUser: true, joinedAt: at(50) }),
      member("o1", "owner", { joinedAt: at(2) }),
    ];
    expect([...members].sort(compareMembers).map((m) => m.membershipId)).toEqual([
      "me",
      "o1",
      "o2",
      "c1",
      "c2",
    ]);
  });

  it("is the same whatever order the rows arrive in", () => {
    const members = [
      member("a", "owner"),
      member("b", "collaborator"),
      member("c", "collaborator", { displayName: "Ana" }),
    ];
    const once = labelMembers(members).map((m) => m.label);
    expect(labelMembers([...members].reverse()).map((m) => m.label)).toEqual(once);
  });
});

describe("assigneeLabel", () => {
  const members = labelMembers([
    member("me", "owner", { isCurrentUser: true }),
    member("sofia", "collaborator", { displayName: "Sofía" }),
  ]);

  it("shows Sin asignar for an unassigned item", () => {
    expect(assigneeLabel(members, null)).toBe(es.checklist.assignment.unassigned);
  });

  it("shows Tú or the member's label", () => {
    expect(assigneeLabel(members, "me")).toBe("Tú");
    expect(assigneeLabel(members, "sofia")).toBe("Sofía");
  });

  it("never shows a stale or unknown id: it is Sin asignar", () => {
    expect(assigneeLabel(members, "gone")).toBe(es.checklist.assignment.unassigned);
  });
});

describe("parseDisplayName", () => {
  it("trims, and blank means no name", () => {
    expect(parseDisplayName("  Sofía ")).toEqual({ ok: true, displayName: "Sofía" });
    expect(parseDisplayName("")).toEqual({ ok: true, displayName: null });
    expect(parseDisplayName(" \t\n ")).toEqual({ ok: true, displayName: null });
  });

  it("accepts up to the limit, counting characters, not bytes", () => {
    expect(parseDisplayName("ñ".repeat(DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(parseDisplayName("a".repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: es.members.displayName.tooLong,
    });
  });

  it("is plain text: control characters are refused, markup is just text", () => {
    expect(parseDisplayName("So\u0007fía")).toEqual({
      ok: false,
      error: es.members.displayName.invalid,
    });
    expect(parseDisplayName("<b>Ana</b>")).toEqual({ ok: true, displayName: "<b>Ana</b>" });
  });
});

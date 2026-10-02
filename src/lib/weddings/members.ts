import { interpolate } from "@/lib/i18n";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Wedding members as the checklist presents them. Pure functions only.
 *
 * A member's identity inside a wedding is their membership: never an auth
 * user id, never an email. Labels come from what the member chose for this
 * wedding (`displayName`) or from a neutral, role-based fallback.
 */

type WeddingRole = Database["public"]["Enums"]["wedding_role"];

/** Safe fields of one membership; nothing about the auth user behind it. */
export type WeddingMember = Readonly<{
  membershipId: string;
  role: WeddingRole;
  displayName: string | null;
  isCurrentUser: boolean;
  /** Tie-break only (ISO timestamp); never shown. */
  joinedAt: string;
}>;

export type LabeledMember = WeddingMember &
  Readonly<{
    /** Short label for rows: "Tú", "Sofía", "Persona colaboradora 2". */
    label: string;
    /** Label in pickers: "Tú (Sofía)" for yourself when you have a name. */
    optionLabel: string;
  }>;

/** What a client-side picker needs: no role, timestamps or other fields. */
export type MemberOption = Readonly<{ membershipId: string; optionLabel: string }>;

const ROLE_RANK: Record<WeddingRole, number> = { owner: 0, collaborator: 1 };

/**
 * Deterministic member order: you first, then owners, then collaborators;
 * within a role, who joined first, then membership id (never shown).
 */
export function compareMembers(a: WeddingMember, b: WeddingMember): number {
  if (a.isCurrentUser !== b.isCurrentUser) return a.isCurrentUser ? -1 : 1;
  if (a.role !== b.role) return ROLE_RANK[a.role] - ROLE_RANK[b.role];
  if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
  return a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0;
}

/**
 * Orders and labels a wedding's members:
 *   - you: "Tú" (option "Tú (name)" when you have a name);
 *   - another member with a name: the name;
 *   - another member without one: "Persona organizadora" / "Persona
 *     colaboradora", numbered in member order when several of the same role
 *     have no name ("Persona colaboradora 1", "… 2").
 */
export function labelMembers(members: readonly WeddingMember[]): LabeledMember[] {
  const copy = es.members;
  const ordered = [...members].sort(compareMembers);
  const unnamed = (role: WeddingRole) =>
    ordered.filter((m) => !m.isCurrentUser && m.displayName === null && m.role === role);

  const fallbackNumbers = new Map<string, number>();
  for (const role of ["owner", "collaborator"] as const) {
    const group = unnamed(role);
    if (group.length < 2) continue;
    group.forEach((member, index) => fallbackNumbers.set(member.membershipId, index + 1));
  }

  return ordered.map((member) => {
    if (member.isCurrentUser) {
      return {
        ...member,
        label: copy.you,
        optionLabel: member.displayName
          ? interpolate(copy.youNamed, { name: member.displayName })
          : copy.you,
      };
    }
    if (member.displayName) {
      return { ...member, label: member.displayName, optionLabel: member.displayName };
    }
    const number = fallbackNumbers.get(member.membershipId);
    const base = copy.fallback[member.role];
    const label =
      number === undefined
        ? base
        : interpolate(copy.fallbackNumbered, { name: base, number: String(number) });
    return { ...member, label, optionLabel: label };
  });
}

/** The label for an item's assignee: "Sin asignar" when nobody (or nobody known) has it. */
export function assigneeLabel(
  members: readonly LabeledMember[],
  assigneeMembershipId: string | null,
): string {
  if (assigneeMembershipId === null) return es.checklist.assignment.unassigned;
  return (
    members.find((m) => m.membershipId === assigneeMembershipId)?.label ??
    es.checklist.assignment.unassigned
  );
}

import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { formatMoney } from "@/lib/vendors/money";
import { attentionPath } from "@/lib/weddings/overview/attention";
import type {
  AttentionItem,
  AttentionKind,
  AttentionLevel,
  ChecklistOverview,
  DomainResult,
  GuestsOverview,
  MoneyBucket,
  OverviewDomain,
  VendorsOverview,
  WeddingCountdown,
  WeddingOverview,
  WeddingsOverview,
} from "@/lib/weddings/overview/types";
import { formatWeddingDate } from "@/lib/weddings/format";
import type { WeddingSummary } from "@/lib/weddings/service";

/**
 * "Mis bodas" presentation (LB-24C, ADR-018 §12). Pure: turns the LB-24B
 * overview into display strings and view models. It never decides whether
 * attention exists, never reads domain rows, never reorders items and never
 * recomputes `complete` / `allClear`: those are the overview's. Money is
 * formatted per currency here, on the server, so no `bigint` reaches a client
 * component and CRC and USD are never combined.
 */

/** Display caps (presentation only; the overview keeps every item). */
export const GLOBAL_ATTENTION_CAP = 6;
export const CARD_ATTENTION_CAP = 2;

type Copy = ReturnType<typeof getMessages>["app"]["weddings"];

function copy(): Copy {
  return getMessages().app.weddings;
}

function count(value: number): string {
  return formatNumber(value);
}

/** Singular / plural catalog pair, `{count}` filled in. */
function plural(value: number, one: string, many: string): string {
  return value === 1 ? one : interpolate(many, { count: count(value) });
}

// ---------------------------------------------------------------- wedding

export function roleLabel(role: WeddingSummary["role"]): string {
  return role === "owner" ? copy().roleOwner : copy().roleCollaborator;
}

/** "14 de agosto de 2027 · Escazú", or "Fecha por definir". */
export function weddingDateLine(wedding: Pick<WeddingSummary, "weddingDate" | "city">): string {
  const date = wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : copy().noDate;
  return wedding.city ? `${date} · ${wedding.city}` : date;
}

/** The overview's countdown in words; null when it has none (undated, no time zone). */
export function countdownLabel(countdown: WeddingCountdown): string | null {
  const words = copy().countdown;
  switch (countdown.state) {
    case "before":
      return countdown.days === 1 ? words.beforeOne : interpolate(words.beforeMany, { days: count(countdown.days) });
    case "today":
      return words.today;
    case "after":
      return countdown.days === 1 ? words.afterOne : interpolate(words.afterMany, { days: count(countdown.days) });
    case "undated":
    case "no_time_zone":
      return null;
  }
}

// -------------------------------------------------------------- attention

export function attentionLevelLabel(level: AttentionLevel): string {
  return copy().attention.levels[level];
}

export function attentionTitle(kind: AttentionKind): string {
  return copy().attention.titles[kind];
}

/** One formatted amount per currency bucket, in the overview's order (CRC, then USD). Never summed. */
export function formatAmounts(amounts: readonly MoneyBucket[]): string[] {
  return amounts.map((bucket) => formatMoney(bucket.amountMinor, bucket.currency));
}

/**
 * The item's detail line from its own fields only (count, amounts, since).
 * `budget_total_over` shows no count (its count is currencies, not records).
 */
export function attentionDetail(item: AttentionItem, role: WeddingSummary["role"]): string {
  const words = copy().attention;
  const amounts = formatAmounts(item.amounts);
  const date = item.since === null ? null : formatWeddingDate(item.since);
  const parts: (string | null)[] = (() => {
    switch (item.kind) {
      case "payment_overdue":
        return [
          plural(item.count, words.installmentsOne, words.installmentsMany),
          ...amounts,
          date && interpolate(words.since, { date }),
        ];
      case "checklist_overdue":
        return [
          plural(item.count, words.checklistItemsOne, words.checklistItemsMany),
          date && interpolate(words.since, { date }),
        ];
      case "payment_due_soon":
        return [
          plural(item.count, words.installmentsOne, words.installmentsMany),
          ...amounts,
          date && interpolate(item.count === 1 ? words.dueOn : words.firstDueOn, { date }),
        ];
      case "seated_declined":
        return [plural(item.count, words.peopleOne, words.peopleMany)];
      case "payment_to_unbooked_vendor":
        return [plural(item.count, words.vendorsOne, words.vendorsMany), ...amounts];
      case "budget_total_over":
        return amounts.map((amount) => interpolate(words.overBy, { amount }));
      case "wedding_date_missing":
      case "wedding_time_zone_missing":
        return [role === "owner" ? words.setupOwner : words.setupCollaborator];
    }
  })();
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export type AttentionRowView = Readonly<{
  id: string;
  kind: AttentionKind;
  level: AttentionLevel;
  levelLabel: string;
  weddingName: string;
  title: string;
  detail: string;
  /** Always `attentionPath`: owner-only settings fall back to the wedding home. */
  href: string;
  /** Visible text "Revisar" first, then what and where. */
  linkLabel: string;
}>;

export function attentionRow(
  item: AttentionItem,
  wedding: Pick<WeddingSummary, "name" | "role">,
): AttentionRowView {
  const title = attentionTitle(item.kind);
  return {
    id: item.id,
    kind: item.kind,
    level: item.level,
    levelLabel: attentionLevelLabel(item.level),
    weddingName: wedding.name,
    title,
    detail: attentionDetail(item, wedding.role),
    href: attentionPath(item.weddingId, item.destination, wedding.role),
    linkLabel: interpolate(copy().attention.reviewLabel, { title, wedding: wedding.name }),
  };
}

// -------------------------------------------------------------- card facts

export type CardFact = Readonly<{ label: string; value: string; unavailable: boolean }>;

const unavailableFact = (label: string): CardFact => ({ label, value: copy().card.unavailable, unavailable: true });

export function checklistFact(result: DomainResult<ChecklistOverview>): CardFact {
  const words = copy().card;
  if (result.status !== "ok") return unavailableFact(words.checklistLabel);
  const { done, applicable } = result.value.progress;
  const value =
    applicable === 0
      ? words.checklistEmpty
      : interpolate(words.checklistValue, { done: count(done), applicable: count(applicable) });
  return { label: words.checklistLabel, value, unavailable: false };
}

export function guestsFact(result: DomainResult<GuestsOverview>): CardFact {
  const words = copy().card;
  if (result.status !== "ok") return unavailableFact(words.guestsLabel);
  const { total, attending, pending } = result.value.guests;
  const value =
    total === 0
      ? words.guestsEmpty
      : interpolate(words.guestsValue, { attending: count(attending), pending: count(pending) });
  return { label: words.guestsLabel, value, unavailable: false };
}

export function vendorsFact(result: DomainResult<VendorsOverview>): CardFact {
  const words = copy().card;
  if (result.status !== "ok") return unavailableFact(words.vendorsLabel);
  const { total, byStatus } = result.value;
  const value = total === 0 ? words.vendorsEmpty : plural(byStatus.booked, words.vendorsValueOne, words.vendorsValueMany);
  return { label: words.vendorsLabel, value, unavailable: false };
}

// ------------------------------------------------------------------- cards

export type BasicCardView = Readonly<{
  id: string;
  name: string;
  href: string;
  dateLine: string;
  roleLabel: string;
}>;

export type RichCardView = BasicCardView &
  Readonly<{
    countdown: string | null;
    /** The overview's highest level for this wedding: drives the card accent. */
    accent: AttentionLevel | null;
    attentionCount: string | null;
    attention: readonly AttentionRowView[];
    /** Beyond the card cap: inside a native disclosure, never dropped. */
    moreAttention: readonly AttentionRowView[];
    moreLabel: string | null;
    facts: readonly [CardFact, CardFact, CardFact];
    /** "Algunos datos … no están disponibles." */
    partial: boolean;
    /** No attention AND nothing unavailable. */
    allClear: boolean;
  }>;

export function basicCard(wedding: WeddingSummary): BasicCardView {
  return {
    id: wedding.id,
    name: wedding.name,
    href: `/app/weddings/${wedding.id}`,
    dateLine: weddingDateLine(wedding),
    roleLabel: roleLabel(wedding.role),
  };
}

export function richCard(overview: WeddingOverview): RichCardView {
  const words = copy().card;
  const rows = overview.attention.map((item) => attentionRow(item, overview.wedding));
  const shown = rows.slice(0, CARD_ATTENTION_CAP);
  const more = rows.slice(CARD_ATTENTION_CAP);
  return {
    ...basicCard(overview.wedding),
    countdown: countdownLabel(overview.countdown),
    accent: overview.attentionLevel,
    attentionCount: rows.length === 0 ? null : plural(rows.length, words.attentionCountOne, words.attentionCountMany),
    attention: shown,
    moreAttention: more,
    moreLabel: more.length === 0 ? null : interpolate(words.attentionMore, { count: count(more.length) }),
    facts: [checklistFact(overview.checklist), guestsFact(overview.guests), vendorsFact(overview.vendors)],
    partial: overview.unavailableDomains.length > 0,
    allClear: overview.attention.length === 0 && overview.unavailableDomains.length === 0,
  };
}

// -------------------------------------------------------------------- page

type ReadyOverview = Extract<WeddingsOverview, { status: "ready" }>;

export function domainLabels(domains: readonly OverviewDomain[]): string {
  const labels = copy().overview.domains;
  return domains.map((domain) => labels[domain]).join(", ");
}

/**
 * The header's summary line. Complete: "{n} de {total} bodas necesitan
 * atención". Incomplete: only what was found ("Encontramos pendientes en
 * {n} bodas."), never implying the rest are clear. Nothing to say → null.
 */
export function headerSummary(overview: ReadyOverview): string | null {
  const words = copy().overview;
  const needing = overview.weddingsNeedingAttention;
  if (needing === 0) return null;
  if (!overview.complete) return plural(needing, words.summaryPartialOne, words.summaryPartialMany);
  if (overview.weddings.length === 1) return words.summarySingle;
  return interpolate(needing === 1 ? words.summaryOne : words.summaryMany, {
    count: count(needing),
    total: count(overview.weddings.length),
  });
}

/** The global attention panel: 2+ weddings with attention; the overview's order, first six. */
export function globalAttention(
  overview: ReadyOverview,
): Readonly<{ rows: readonly AttentionRowView[]; moreLabel: string | null }> | null {
  if (overview.weddings.length < 2 || overview.attention.length === 0) return null;
  const byId = new Map(overview.weddings.map((entry) => [entry.wedding.id, entry.wedding]));
  const rows = overview.attention.slice(0, GLOBAL_ATTENTION_CAP).flatMap((item) => {
    const wedding = byId.get(item.weddingId);
    return wedding ? [attentionRow(item, wedding)] : [];
  });
  const hidden = overview.attention.length - GLOBAL_ATTENTION_CAP;
  const words = copy().overview;
  return { rows, moreLabel: hidden > 0 ? plural(hidden, words.attentionMoreOne, words.attentionMoreMany) : null };
}

/** The page's reassurance: only a complete, all-clear overview of 2+ weddings. */
export function showPageAllClear(overview: ReadyOverview): boolean {
  return overview.complete && overview.allClear && overview.weddings.length >= 2;
}

export type MyWeddingsListView =
  | Readonly<{
      mode: "rich";
      summary: string | null;
      notice: string | null;
      attention: ReturnType<typeof globalAttention>;
      allClear: boolean;
      cards: readonly RichCardView[];
    }>
  /** Overview failed or over its limit: the authorized list itself, never empty, never partial. */
  | Readonly<{ mode: "basic"; notice: string; cards: readonly BasicCardView[] }>;

/**
 * The list page from the entry's authorized list and the overview. Error and
 * over-limit fall back to basic cards from `weddings` (the first
 * `listMyWeddings`), with a notice: never the empty state, never a partial
 * summary. Card order is the list's; urgency order lives only in the panel.
 */
export function myWeddingsListView(weddings: readonly WeddingSummary[], overview: WeddingsOverview): MyWeddingsListView {
  const words = copy().overview;
  switch (overview.status) {
    case "error":
      return { mode: "basic", notice: words.error, cards: weddings.map(basicCard) };
    case "over_limit":
      return {
        mode: "basic",
        notice: interpolate(words.overLimit, {
          limit: count(overview.limit),
          count: count(overview.weddingCount),
        }),
        cards: weddings.map(basicCard),
      };
    case "ready":
      return {
        mode: "rich",
        summary: headerSummary(overview),
        notice: overview.complete
          ? null
          : interpolate(words.partial, { areas: domainLabels(overview.unavailableDomains) }),
        attention: globalAttention(overview),
        allClear: showPageAllClear(overview),
        cards: overview.weddings.map(richCard),
      };
  }
}

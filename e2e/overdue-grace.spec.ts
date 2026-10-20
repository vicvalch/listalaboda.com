import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { addDaysToIsoDate } from "../src/lib/checklist/timing";
import { weddingLocalToday } from "../src/lib/weddings/timezone";
import {
  addChecklistItem,
  checklistItem,
  createAccount,
  createWedding,
  es,
  initializeChecklist,
  logIn,
} from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// Launch remediation Batch 2/2b (ADR-018 §14): a template item whose date was
// already past on the wedding-local day it was seeded gets a 14-day catch-up
// grace; it is overdue from day 15 if still pending. Custom items and items
// due on/after the seed day keep the plain rule; no time zone = nothing is
// overdue. The exact rule is unit-tested (checklist-overdue.test.ts); these
// journeys check that the real pages agree.
//
// Fixture arithmetic. The wedding is TODAY + 100 days in America/Costa_Rica
// (UTC−6 all year, no DST). Template v1 (immutable) then has exactly
// INHERITED template items due before the seed day (offsets −120 … −365), and
// none due in the 15 days before today (the nearest offsets are −120 and −90),
// so the day-14/day-15 counts below are 0 and INHERITED, nothing in between.
//
// Days 14 and 15 are reached by moving the seeded items' `created_at` (the
// seed instant) back in the LOCAL database, as the superuser. That is fixture
// setup only: the app never writes it, and every page is read as the
// signed-in owner.

const ZONE = "America/Costa_Rica";
const ZONE_OFFSET = "-06:00";
const WEDDING_IN_DAYS = 100;
const INHERITED = 20;
const BUDGET = "Definir el presupuesto aproximado"; // −365 days: inherited

const overdueCopy = es.checklist.overdue;
const settingsCopy = es.weddingSettings;

function today(): string {
  return weddingLocalToday(ZONE, new Date())!;
}

function daysFromToday(days: number): string {
  return addDaysToIsoDate(today(), days)!;
}

/** Moves the seed instant of every template-seeded item of the wedding (LOCAL database only). */
async function setSeedInstant(weddingId: string, instant: string) {
  const client = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `update public.checklist_items set created_at = $2::timestamptz
       where wedding_id = $1 and source_template_item_id is not null`,
      [weddingId, instant],
    );
    expect(rowCount).toBe(38);
  } finally {
    await client.end();
  }
}

async function setTimeZone(page: Page, weddingId: string, zone: string) {
  await page.goto(`/app/weddings/${weddingId}/settings`);
  await page.getByLabel(es.weddingNew.timeZoneLabel).selectOption(zone);
  await page.getByRole("button", { name: settingsCopy.submit }).click();
  await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
}

/** A planner's wedding TODAY + 100 days out, its suggested checklist seeded now. */
async function seededWedding(page: Page, label: string, zone: string | null = ZONE) {
  await logIn(page, await createAccount(label, "planner"));
  const weddingId = await createWedding(page, `Boda ${label}`, daysFromToday(WEDDING_IN_DAYS));
  if (zone) await setTimeZone(page, weddingId, zone);
  await page.goto(`/app/weddings/${weddingId}`);
  await initializeChecklist(page);
  return { weddingId, base: `/app/weddings/${weddingId}` };
}

function overdueCount(page: Page) {
  return page.getByTestId("overdue-summary").getByTestId("overdue-count");
}

async function expectNothingOverdue(page: Page, base: string) {
  await page.goto(base);
  await expect(page.getByTestId("checklist-item")).toHaveCount(38);
  await expect(page.getByTestId("overdue-summary")).toHaveCount(0);
  await expect(page.getByTestId("checklist-item-overdue")).toHaveCount(0);
  // Plan view: no "Atrasados" section at all, every item in the one pending list.
  await page.goto(`${base}?view=plan`);
  await expect(page.getByTestId("plan-overdue")).toHaveCount(0);
  await expect(page.getByTestId("checklist-item")).toHaveCount(38);
}

/** The planner's "Mis bodas" card for the wedding (always the list via ?all=1). */
async function myWeddingsCard(page: Page) {
  await page.goto("/app?all=1");
  const card = page.getByTestId("wedding-card");
  await expect(card).toHaveCount(1);
  return card;
}

test.describe("inherited-item catch-up grace (Batch 2/2b)", () => {
  test("OG1: a new wedding starts with nothing Atrasado; the template's own dates are shown", async ({ page }) => {
    const { base } = await seededWedding(page, "og-new");

    await expectNothingOverdue(page, base);

    // The grace never rewrites the template's rule or its displayed date.
    await page.goto(base);
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-timing")).toContainText(
      "365 días antes de la boda",
    );
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-status")).toHaveText(
      es.checklist.status.pending,
    );

    await expect(await myWeddingsCard(page)).not.toContainText(
      es.app.weddings.attention.titles.checklist_overdue,
    );
  });

  test("OG2: custom items keep the plain rule: a past date is Atrasado at once, due today is not", async ({
    page,
  }) => {
    const { base } = await seededWedding(page, "og-custom");

    await addChecklistItem(page, {
      title: "Pagar el adelanto del lugar",
      timing: { mode: "absolute", date: daysFromToday(-1) },
    });
    await addChecklistItem(page, {
      title: "Confirmar la música",
      timing: { mode: "relative", days: WEDDING_IN_DAYS + 2, direction: "before" },
    });
    await addChecklistItem(page, {
      title: "Llamar a la floristería",
      timing: { mode: "absolute", date: today() },
    });

    // Earliest first: the custom relative item (2 days ago), then yesterday's.
    await page.goto(base);
    await expect(overdueCount(page)).toHaveText("2");
    await expect(page.getByTestId("overdue-items").getByRole("link")).toHaveText([
      "Confirmar la música",
      "Pagar el adelanto del lugar",
    ]);
    await expect(
      checklistItem(page, "Pagar el adelanto del lugar").getByTestId("checklist-item-overdue"),
    ).toHaveText(overdueCopy.badge);
    await expect(
      checklistItem(page, "Llamar a la floristería").getByTestId("checklist-item-overdue"),
    ).toHaveCount(0);
    // The inherited template items are still in their grace.
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-overdue")).toHaveCount(0);
    await expect(page.getByTestId("checklist-item-overdue")).toHaveCount(2);
  });

  test("OG3: day 14 is still grace; day 15 is Atrasado, measured in wedding-local days", async ({ page }) => {
    const { weddingId, base } = await seededWedding(page, "og-boundary");

    // Day 14: seeded at 00:01 wedding-local time, 14 days ago.
    await setSeedInstant(weddingId, `${daysFromToday(-14)}T00:01:00${ZONE_OFFSET}`);
    await expectNothingOverdue(page, base);
    await expect(await myWeddingsCard(page)).not.toContainText(
      es.app.weddings.attention.titles.checklist_overdue,
    );

    // Day 15: seeded at 23:59 wedding-local time, 15 days ago. In UTC that
    // instant is already the NEXT calendar day (day 14), so a UTC seed day
    // would still be in the grace: the wedding-local seed day makes it overdue.
    await setSeedInstant(weddingId, `${daysFromToday(-15)}T23:59:00${ZONE_OFFSET}`);
    await page.goto(base);
    await expect(overdueCount(page)).toHaveText(String(INHERITED));
    await expect(page.getByTestId("checklist-item-overdue")).toHaveCount(INHERITED);
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-overdue")).toHaveText(
      overdueCopy.badge,
    );
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-status")).toHaveText(
      es.checklist.status.pending,
    );
    await page.goto(`${base}?view=plan`);
    await expect(page.getByTestId("plan-overdue").getByTestId("checklist-item")).toHaveCount(INHERITED);

    const card = await myWeddingsCard(page);
    await expect(card).toHaveAttribute("data-attention-level", "overdue");
    await expect(card).toContainText(es.app.weddings.attention.titles.checklist_overdue);

    // Done is never overdue, grace or not.
    await page.goto(base);
    await checklistItem(page, BUDGET).getByRole("checkbox").click();
    await expect(checklistItem(page, BUDGET)).toHaveAttribute("data-status", "done");
    await expect(overdueCount(page)).toHaveText(String(INHERITED - 1));
  });

  test("OG4: without a time zone nothing is Atrasado, even past the grace; setting one applies it", async ({
    page,
  }) => {
    const { weddingId, base } = await seededWedding(page, "og-nozone", null);

    await setSeedInstant(weddingId, `${daysFromToday(-30)}T12:00:00${ZONE_OFFSET}`);
    await page.goto(base);
    await expect(page.getByTestId("checklist-no-time-zone")).toHaveCount(1);
    await expect(page.getByTestId("overdue-summary")).toHaveCount(0);
    await expect(page.getByTestId("checklist-item-overdue")).toHaveCount(0);

    await setTimeZone(page, weddingId, ZONE);
    await expect(page.getByTestId("checklist-no-time-zone")).toHaveCount(0);
    await expect(overdueCount(page)).toHaveText(String(INHERITED));
  });
});

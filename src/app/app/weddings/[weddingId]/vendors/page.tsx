import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/vendors/money";
import { VENDOR_STATUSES } from "@/lib/vendors/presentation";
import { listWeddingVendors } from "@/lib/vendors/service";
import {
  parseVendorCategoryParam,
  parseVendorStatusParam,
  suggestedCurrency,
  summarizeVendors,
  vendorMainAmount,
  type VendorListItem,
  type VendorSummary,
} from "@/lib/vendors/summary";
import type { VendorFormValues } from "@/lib/vendors/validation";
import { getWeddingDetail } from "@/lib/weddings/service";

import { createVendorAction } from "./actions";
import { VendorForm } from "./VendorForm";
import { VendorList, type VendorCardView } from "./VendorList";

export const metadata: Metadata = { title: getMessages().vendors.title };

const copy = getMessages().vendors;

/**
 * "Proveedores" (LB-21, ADR-014): the wedding's vendor engagements — a
 * secondary area next to the checklist (which stays the wedding's home). Any
 * member, owner or collaborator, sees and manages it; membership is checked
 * server-side first, and a non-member, a nonexistent wedding and a malformed
 * id all get the same 404. The vendors load after that check in ONE query
 * (without notes); the summary is derived here, grouping/search/filters in
 * the client list over that same data.
 */
export default async function VendorsPage({ params, searchParams }: PageProps<"/app/weddings/[weddingId]/vendors">) {
  const { weddingId } = await params;
  const query = await searchParams;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/vendors`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const [wedding, vendors] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    listWeddingVendors(supabase, access.access),
  ]);
  if (!wedding) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        <p className="text-sm">
          <Link href={`/app/weddings/${wedding.id}`} className={textLinkClass}>
            {copy.backToChecklist}
          </Link>
        </p>
      </header>

      {vendors === null ? (
        <Notice tone="error">{copy.loadFailed}</Notice>
      ) : (
        <>
          {vendors.length === 0 ? (
            <section data-testid="vendors-empty" className={`${cardClass} space-y-2`}>
              <h2 className="text-xl font-semibold">{copy.empty.title}</h2>
              <p className="text-muted">{copy.empty.body}</p>
            </section>
          ) : (
            <SummarySection summary={summarizeVendors(vendors)} />
          )}

          <CreateVendor weddingId={wedding.id} vendors={vendors} />

          {vendors.length > 0 ? (
            <VendorList
              weddingId={wedding.id}
              vendors={vendors.map(cardView)}
              initialCategory={parseVendorCategoryParam(query.category)}
              initialStatus={parseVendorStatusParam(query.status)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function cardView(vendor: VendorListItem): VendorCardView {
  const amount = vendorMainAmount(vendor);
  const amountText = amount
    ? interpolate(amount.kind === "contracted" ? copy.card.contracted : copy.card.quote, {
        amount: formatMoney(amount.minor, amount.currency),
      })
    : null;
  return { ...vendor, amountText };
}

function SummarySection({ summary }: { summary: VendorSummary }) {
  return (
    <section aria-label={copy.summary.label} data-testid="vendor-summary" className="space-y-3">
      <p className="text-2xl font-semibold" data-testid="vendor-summary-total">
        {summary.total === 1
          ? copy.summary.totalOne
          : interpolate(copy.summary.totalMany, { count: formatNumber(summary.total) })}
      </p>
      <ul className="flex flex-wrap gap-2 text-sm">
        {VENDOR_STATUSES.filter((status) => summary.byStatus[status] > 0).map((status) => (
          <li
            key={status}
            data-testid={`vendor-summary-${status}`}
            className="rounded-full border border-border bg-surface px-3 py-1 font-semibold"
          >
            {summary.byStatus[status] === 1
              ? copy.summary.byStatusOne[status]
              : interpolate(copy.summary.byStatus[status], { count: formatNumber(summary.byStatus[status]) })}
          </li>
        ))}
      </ul>
      {summary.contractedTotals.length > 0 ? (
        <div className="space-y-1">
          {/* One line per currency: amounts in different currencies are never added. */}
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-semibold">{copy.summary.contracted}</span>
            {summary.contractedTotals.map((total) => (
              <span key={total.currency} data-testid={`vendor-contracted-${total.currency}`} className="font-semibold">
                {formatMoney(total.totalMinor, total.currency)}
              </span>
            ))}
          </p>
          <p className="text-muted text-sm">{copy.summary.contractedHint}</p>
        </div>
      ) : null}
    </section>
  );
}

function CreateVendor({ weddingId, vendors }: { weddingId: string; vendors: readonly VendorListItem[] }) {
  const defaults: VendorFormValues = {
    name: "",
    category: "",
    customCategory: "",
    status: "considering",
    contactName: "",
    email: "",
    phone: "",
    instagramHandle: "",
    // A suggestion from the list already loaded; dropped if no amount is entered.
    currency: suggestedCurrency(vendors) ?? "",
    quotedAmount: "",
    contractedAmount: "",
    notes: "",
  };
  return (
    <details className="group">
      <summary
        className={`${primaryButtonClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        {copy.create.open}
      </summary>
      <section aria-labelledby="new-vendor-title" className={`${cardClass} mt-4 space-y-4`}>
        <h2 id="new-vendor-title" className="text-xl font-semibold">
          {copy.create.title}
        </h2>
        <VendorForm
          action={createVendorAction}
          weddingId={weddingId}
          id="new-vendor"
          defaults={defaults}
          submitLabel={copy.create.submit}
          pendingLabel={copy.create.submitting}
        />
      </section>
    </details>
  );
}

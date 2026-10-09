import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { vendorFinance } from "@/lib/budget/summary";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/vendors/money";
import {
  instagramProfileUrl,
  mailtoHref,
  phoneHref,
  vendorCategoryDisplay,
  vendorStatusLabel,
} from "@/lib/vendors/presentation";
import { getWeddingVendor, type VendorDetail } from "@/lib/vendors/service";
import { vendorFormValues } from "@/lib/vendors/validation";
import { getWeddingTimeZone } from "@/lib/weddings/service";
import { weddingLocalToday } from "@/lib/weddings/timezone";

import { ConfirmButton } from "../../guests/ConfirmButton";
import { deleteVendorAction, updateVendorAction } from "../actions";
import { VendorForm } from "../VendorForm";
import { VendorPayments } from "./VendorPayments";

export const metadata: Metadata = { title: getMessages().vendors.title };

const copy = getMessages().vendors;

/**
 * One vendor engagement (LB-21, ADR-014): its details and notes, the edit
 * form (every field, status included, in one write) and the explicit delete.
 * Membership is checked first; the vendor is then read in ONE query scoped by
 * id AND wedding, so another wedding's vendor id, a deleted vendor and a
 * malformed id all get the same 404 as a non-member.
 *
 * LB-22 (ADR-015): "Pagos" — the vendor's schedule items and payments come
 * embedded in that same vendor query, plus one read of the wedding's time
 * zone; the clock is read once here and every state is derived in memory.
 */
export default async function VendorPage({ params }: PageProps<"/app/weddings/[weddingId]/vendors/[vendorId]">) {
  const { weddingId, vendorId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/vendors/${encodeURIComponent(vendorId)}`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const [result, timeZone] = await Promise.all([
    getWeddingVendor(supabase, access.access, vendorId),
    getWeddingTimeZone(supabase, access.access.weddingId),
  ]);
  if (!result.ok && result.reason === "not_found") notFound();
  const listHref = `/app/weddings/${access.access.weddingId}/vendors`;
  // One clock read, turned into the wedding's calendar date. No time zone (or
  // a failed read) = no "today": dates show, nothing is overdue or due soon.
  const today = timeZone ? weddingLocalToday(timeZone, new Date()) : null;

  return (
    <div className="space-y-8">
      <p className="text-sm">
        <Link href={listHref} className={textLinkClass}>
          {copy.backToList}
        </Link>
      </p>
      {result.ok ? (
        <VendorDetailView weddingId={access.access.weddingId} vendor={result.vendor} today={today} />
      ) : (
        <Notice tone="error">{copy.loadFailed}</Notice>
      )}
    </div>
  );
}

function VendorDetailView({
  weddingId,
  vendor,
  today,
}: {
  weddingId: string;
  vendor: VendorDetail;
  today: string | null;
}) {
  const d = copy.detail;
  const finance = vendorFinance(vendor, today);
  const email = vendor.email ? mailtoHref(vendor.email) : null;
  const phone = vendor.phone ? phoneHref(vendor.phone) : null;
  const instagram = vendor.instagramHandle ? instagramProfileUrl(vendor.instagramHandle) : null;
  const money = (minor: number | null) =>
    minor !== null && vendor.currency !== null ? formatMoney(minor, vendor.currency) : null;

  const rows: { key: string; label: string; value: ReactNode }[] = [
    { key: "category", label: d.category, value: vendorCategoryDisplay(vendor) },
    { key: "status", label: d.status, value: vendorStatusLabel(vendor.status) },
    { key: "contact", label: d.contactName, value: vendor.contactName },
    {
      key: "email",
      label: d.email,
      value:
        vendor.email && email ? (
          <a href={email} className={`${textLinkClass} break-all`}>
            {vendor.email}
          </a>
        ) : null,
    },
    {
      key: "phone",
      label: d.phone,
      value:
        vendor.phone && phone ? (
          <a href={phone} className={textLinkClass}>
            {vendor.phone}
          </a>
        ) : null,
    },
    {
      key: "instagram",
      label: d.instagram,
      value:
        vendor.instagramHandle && instagram ? (
          <a href={instagram} target="_blank" rel="noopener noreferrer" className={`${textLinkClass} break-all`}>
            {interpolate(d.instagramLink, { handle: vendor.instagramHandle })}
          </a>
        ) : null,
    },
    { key: "quote", label: d.quote, value: money(vendor.quotedAmountMinor) },
    { key: "contracted", label: d.contracted, value: money(vendor.contractedAmountMinor) },
  ];

  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight break-words" data-testid="vendor-name">
          {vendor.name}
        </h1>
      </header>

      <section aria-label={vendor.name} className={`${cardClass} space-y-6`}>
        <dl className="grid gap-4 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.key} data-testid={`vendor-detail-${row.key}`} className="min-w-0">
              <dt className="text-muted text-sm">{row.label}</dt>
              <dd className="font-semibold break-words">{row.value ?? <span className="text-muted font-normal">{d.none}</span>}</dd>
            </div>
          ))}
        </dl>
        <div data-testid="vendor-detail-notes" className="space-y-1">
          <h2 className="text-muted text-sm">{d.notes}</h2>
          {vendor.notes ? (
            <p className="break-words whitespace-pre-line">{vendor.notes}</p>
          ) : (
            <p className="text-muted">{d.none}</p>
          )}
        </div>
      </section>

      <VendorPayments
        weddingId={weddingId}
        finance={finance}
        currency={vendor.currency}
        timingUnavailable={today === null}
      />

      <section aria-labelledby="edit-vendor-title" className={`${cardClass} space-y-4`}>
        <h2 id="edit-vendor-title" className="text-xl font-semibold">
          {copy.edit.title}
        </h2>
        <VendorForm
          action={updateVendorAction}
          weddingId={weddingId}
          vendorId={vendor.id}
          id={`edit-${vendor.id}`}
          defaults={vendorFormValues(vendor)}
          currencyLocked={finance.hasFinancialRecords}
          submitLabel={copy.edit.submit}
          pendingLabel={copy.edit.submitting}
        />
      </section>

      <section className="space-y-2">
        {finance.hasFinancialRecords ? (
          // The database refuses it too (NO ACTION foreign keys); say why up front.
          <p className="text-muted text-sm" data-testid="vendor-delete-blocked">
            {copy.deleteBlocked}
          </p>
        ) : (
        <ConfirmButton
          action={deleteVendorAction}
          hidden={{ weddingId, vendorId: vendor.id }}
          id={`delete-${vendor.id}`}
          openLabel={copy.delete.open}
          confirmTitle={interpolate(copy.delete.confirmTitle, { vendor: vendor.name })}
          confirmBody={[copy.delete.confirmBody]}
          confirmLabel={copy.delete.confirm}
          cancelLabel={copy.delete.cancel}
        />
        )}
      </section>
    </>
  );
}

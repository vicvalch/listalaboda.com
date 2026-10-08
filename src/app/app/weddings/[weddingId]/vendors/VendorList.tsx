"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { inputClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import {
  VENDOR_CATEGORIES,
  VENDOR_STATUSES,
  mailtoHref,
  phoneHref,
  vendorCategoryDisplay,
  vendorCategoryLabel,
  vendorStatusLabel,
  type VendorCategory,
  type VendorStatus,
} from "@/lib/vendors/presentation";
import {
  filterVendors,
  groupVendorsByCategory,
  parseVendorCategoryParam,
  parseVendorStatusParam,
  vendorFilterQuery,
  type VendorListItem,
} from "@/lib/vendors/summary";

/** A list row plus its amount line, formatted on the server (one Intl, no hydration drift). */
export type VendorCardView = VendorListItem & Readonly<{ amountText: string | null }>;

type Props = {
  weddingId: string;
  vendors: readonly VendorCardView[];
  initialCategory: VendorCategory | null;
  initialStatus: VendorStatus | null;
};

/**
 * The vendor list (LB-21): grouped by category, most committed first, with a
 * local search and two filters. Everything filters in memory over the data
 * the page already loaded (one query): no request per keystroke.
 *
 * The category and status filters live in the URL (`?category=&status=`),
 * kept in sync without a server round trip; without JavaScript the "Filtrar"
 * button submits them as a plain GET. The free-text search is NEVER in the
 * URL (it has no `name`, so no form submits it): vendor and contact names
 * stay out of URLs, history and server logs.
 */
export function VendorList({ weddingId, vendors, initialCategory, initialStatus }: Props) {
  const copy = getMessages().vendors;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(initialCategory);
  const [status, setStatus] = useState(initialStatus);
  const baseId = useId();

  const shown = useMemo(() => filterVendors(vendors, { query, category, status }), [vendors, query, category, status]);
  const groups = useMemo(() => groupVendorsByCategory(shown), [shown]);

  function updateUrl(next: { category: VendorCategory | null; status: VendorStatus | null }) {
    const url = `${window.location.pathname}${vendorFilterQuery(next)}`;
    window.history.replaceState(window.history.state, "", url);
  }

  const searchId = `${baseId}-search`;
  const categoryId = `${baseId}-category`;
  const statusId = `${baseId}-status`;
  const filtered = Boolean(query.trim() || category || status);

  return (
    <section aria-labelledby="vendor-list-title" className="space-y-6">
      <h2 id="vendor-list-title" className="sr-only">
        {copy.title}
      </h2>

      <form
        method="get"
        aria-label={copy.filters.label}
        className="grid gap-4 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-[2fr_1fr_1fr]"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="space-y-1.5">
          <label htmlFor={searchId} className="block text-sm font-semibold">
            {copy.filters.search}
          </label>
          {/* No `name`: the search term is never submitted or put in the URL. */}
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.filters.searchPlaceholder}
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={categoryId} className="block text-sm font-semibold">
            {copy.filters.category}
          </label>
          <select
            id={categoryId}
            name="category"
            value={category ?? ""}
            onChange={(event) => {
              const next = parseVendorCategoryParam(event.target.value);
              setCategory(next);
              updateUrl({ category: next, status });
            }}
            className={inputClass}
          >
            <option value="">{copy.filters.all}</option>
            {VENDOR_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {vendorCategoryLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={statusId} className="block text-sm font-semibold">
            {copy.filters.status}
          </label>
          <select
            id={statusId}
            name="status"
            value={status ?? ""}
            onChange={(event) => {
              const next = parseVendorStatusParam(event.target.value);
              setStatus(next);
              updateUrl({ category, status: next });
            }}
            className={inputClass}
          >
            <option value="">{copy.filters.allStatuses}</option>
            {VENDOR_STATUSES.map((value) => (
              <option key={value} value={value}>
                {vendorStatusLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <noscript>
          <button type="submit" className={secondaryButtonClass}>
            {copy.filters.apply}
          </button>
        </noscript>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p role="status" data-testid="vendor-results" className="text-muted">
          {filtered
            ? interpolate(copy.filters.results, { shown: String(shown.length), total: String(vendors.length) })
            : null}
        </p>
        {filtered ? (
          <button
            type="button"
            className={textLinkClass}
            onClick={() => {
              setQuery("");
              setCategory(null);
              setStatus(null);
              updateUrl({ category: null, status: null });
            }}
          >
            {copy.filters.clear}
          </button>
        ) : null}
      </div>

      {groups.length === 0 ? <p className="text-muted">{copy.filters.noResults}</p> : null}

      {groups.map((group) => {
        const headingId = `${baseId}-group-${group.category}`;
        return (
          <section key={group.category} aria-labelledby={headingId} data-testid="vendor-group" className="space-y-3">
            <h3 id={headingId} className="text-lg font-semibold">
              {vendorCategoryLabel(group.category)}
            </h3>
            <ul className="space-y-3">
              {group.vendors.map((vendor) => (
                <li key={vendor.id}>
                  <VendorCard weddingId={weddingId} vendor={vendor} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

function VendorCard({ weddingId, vendor }: { weddingId: string; vendor: VendorCardView }) {
  const copy = getMessages().vendors;
  const discarded = vendor.status === "discarded";
  const email = vendor.email ? mailtoHref(vendor.email) : null;
  const phone = vendor.phone ? phoneHref(vendor.phone) : null;

  return (
    <article
      data-testid="vendor-card"
      data-status={vendor.status}
      className={`min-w-0 space-y-2 rounded-2xl border border-border p-4 shadow-sm ${
        discarded ? "bg-background opacity-70" : "bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-lg font-semibold break-words">
            <Link
              href={`/app/weddings/${weddingId}/vendors/${vendor.id}`}
              className={`${textLinkClass} ${discarded ? "line-through decoration-1" : ""}`}
              aria-label={interpolate(copy.card.open, { vendor: vendor.name })}
            >
              {vendor.name}
            </Link>
          </h4>
          {vendor.category === "other" ? (
            <p className="text-muted text-sm break-words">{vendorCategoryDisplay(vendor)}</p>
          ) : null}
        </div>
        <span
          data-testid="vendor-status"
          aria-label={interpolate(copy.card.status, { status: vendorStatusLabel(vendor.status) })}
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
            vendor.status === "booked"
              ? "border-success/40 bg-success-soft text-success"
              : discarded
                ? "border-border text-muted"
                : "border-accent/30 bg-accent-soft"
          }`}
        >
          {vendorStatusLabel(vendor.status)}
        </span>
      </div>

      <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          {vendor.contactName ? <p className="break-words">{vendor.contactName}</p> : null}
          {vendor.email && email ? (
            <p className="break-all">
              <a href={email} className={textLinkClass}>
                {vendor.email}
              </a>
            </p>
          ) : null}
          {vendor.phone && phone ? (
            <p className="break-words">
              <a href={phone} className={textLinkClass}>
                {vendor.phone}
              </a>
            </p>
          ) : null}
        </div>
        {vendor.amountText ? (
          <p data-testid="vendor-amount" className="font-semibold sm:text-right">
            {vendor.amountText}
          </p>
        ) : null}
      </div>
    </article>
  );
}

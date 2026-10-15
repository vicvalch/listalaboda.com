import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { cardClass } from "@/components/ui/styles";
import { canCreateWedding } from "@/lib/accounts/account-type";
import { requireAccountType } from "@/lib/accounts/session";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listMyWeddings } from "@/lib/weddings/service";
import { selectableTimeZones } from "@/lib/weddings/timezone";

import { NewWeddingForm } from "./NewWeddingForm";

export const metadata: Metadata = { title: getMessages().weddingNew.title };

/**
 * Planners create any number of weddings. A couple creates their one wedding
 * (ACCOUNT-01, ADR-020 §5): once they belong to a wedding, this page sends
 * them back to `/app` (their wedding). The action re-checks on submit.
 */
export default async function NewWeddingPage() {
  const { user, accountType } = await requireAccountType("/app/weddings/new");
  if (accountType === "couple") {
    const weddings = await listMyWeddings(await createSupabaseServerClient(), user.id);
    if (!canCreateWedding(accountType, weddings?.length ?? null)) redirect("/app");
  }
  const { weddingNew } = getMessages();

  return (
    <section className={`${cardClass} mx-auto max-w-xl space-y-6`}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{weddingNew.title}</h1>
        <p className="text-muted">{weddingNew.intro}</p>
      </header>
      <NewWeddingForm timeZones={selectableTimeZones()} accountType={accountType} />
    </section>
  );
}

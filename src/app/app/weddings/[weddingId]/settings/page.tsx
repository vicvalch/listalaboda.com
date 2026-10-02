import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWeddingDetail } from "@/lib/weddings/service";

import { WeddingSettingsForm } from "./WeddingSettingsForm";

export const metadata: Metadata = { title: getMessages().weddingSettings.title };

/**
 * Wedding settings: name and date, owner-only (Constitution §3). A
 * non-member gets the same 404 as a missing wedding; a collaborator, who
 * already knows the wedding exists, gets an explanation and no form. The
 * form hiding is cosmetic: the action re-checks the owner role.
 */
export default async function WeddingSettingsPage({
  params,
}: PageProps<"/app/weddings/[weddingId]/settings">) {
  const { weddingId } = await params;
  const weddingPath = `/app/weddings/${encodeURIComponent(weddingId)}`;
  const selfPath = `${weddingPath}/settings`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const wedding = await getWeddingDetail(supabase, access.access.weddingId);
  if (!wedding) notFound();

  const { weddingSettings: copy } = getMessages();
  const isOwner = access.access.role === "owner";

  return (
    <section className={`${cardClass} mx-auto max-w-xl space-y-6`}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted break-words">{wedding.name}</p>
      </header>

      {isOwner ? (
        <>
          <p className="text-muted text-sm">{copy.intro}</p>
          <WeddingSettingsForm
            weddingId={wedding.id}
            name={wedding.name}
            weddingDate={wedding.weddingDate}
          />
        </>
      ) : (
        <Notice tone="info">{copy.ownerOnly}</Notice>
      )}

      <p>
        <Link href={`/app/weddings/${wedding.id}`} className={textLinkClass}>
          {copy.back}
        </Link>
      </p>
    </section>
  );
}

import type { Metadata } from "next";

import { cardClass } from "@/components/ui/styles";
import { requireUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";

import { NewWeddingForm } from "./NewWeddingForm";

export const metadata: Metadata = { title: getMessages().weddingNew.title };

export default async function NewWeddingPage() {
  await requireUser("/app/weddings/new");
  const { weddingNew } = getMessages();

  return (
    <section className={`${cardClass} mx-auto max-w-xl space-y-6`}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{weddingNew.title}</h1>
        <p className="text-muted">{weddingNew.intro}</p>
      </header>
      <NewWeddingForm />
    </section>
  );
}

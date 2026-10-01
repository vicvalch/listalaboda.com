import Link from "next/link";

import { cardClass, primaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";

/**
 * Spanish 404. Also what a signed-in user sees for a wedding they don't
 * belong to: the same page as a wedding that doesn't exist (ADR-002 §8).
 */
export default function NotFound() {
  const { common, notFound } = getMessages();
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <section className={`${cardClass} max-w-md space-y-4 text-center`}>
        <h1 className="text-2xl font-semibold tracking-tight">{notFound.title}</h1>
        <p className="text-muted">{notFound.body}</p>
        <Link href="/" className={primaryButtonClass}>
          {common.goHome}
        </Link>
      </section>
    </main>
  );
}

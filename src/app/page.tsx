import Link from "next/link";

import { FoundationNotice } from "@/components/foundation/FoundationNotice";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";

export default function HomePage() {
  const { home } = getMessages();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
      <FoundationNotice
        brand={home.brand}
        tagline={home.tagline}
        status={home.status}
      />
      <nav className="flex flex-col gap-3 sm:flex-row">
        <Link href="/login" className={primaryButtonClass}>
          {home.login}
        </Link>
        <Link href="/signup" className={secondaryButtonClass}>
          {home.signup}
        </Link>
      </nav>
    </main>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

import { BrandSignature } from "@/components/brand/BrandLogo";
import { cardClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { common } = getMessages();
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <Link href="/" className="mb-8 rounded-md">
        <BrandSignature alt={common.brand} className="h-12 sm:h-14" />
      </Link>
      <div className={`w-full max-w-md ${cardClass}`}>{children}</div>
    </main>
  );
}

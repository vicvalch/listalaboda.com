import { FoundationNotice } from "@/components/foundation/FoundationNotice";
import { getMessages } from "@/lib/i18n";

export default function HomePage() {
  const { home } = getMessages();

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <FoundationNotice
        brand={home.brand}
        tagline={home.tagline}
        status={home.status}
      />
    </main>
  );
}

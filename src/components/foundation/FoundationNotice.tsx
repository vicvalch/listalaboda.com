type FoundationNoticeProps = {
  brand: string;
  tagline: string;
  status: string;
};

/** Minimal placeholder confirming the application shell renders. */
export function FoundationNotice({ brand, tagline, status }: FoundationNoticeProps) {
  return (
    <section className="max-w-xl text-center">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{brand}</h1>
      <p className="mt-4 text-lg">{tagline}</p>
      <p className="text-muted mt-2 text-sm">{status}</p>
    </section>
  );
}

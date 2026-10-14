/**
 * Questions and answers on a marketing page (Marketing Landing V1): native
 * `<details>`/`<summary>` disclosures, so they open by keyboard or touch with
 * no client JavaScript. Plain text answers; open/closed is shown by the
 * marker's shape and by the answer itself, never by color alone.
 */
export function FaqList({ items }: { items: ReadonlyArray<Readonly<{ question: string; answer: string }>> }) {
  return (
    <div className="border-b border-border" data-testid="faq-list">
      {items.map((item) => (
        <details key={item.question} className="group border-t border-border">
          <summary className="flex min-h-14 cursor-pointer list-none items-start justify-between gap-6 rounded-md py-5 text-lg font-semibold [&::-webkit-details-marker]:hidden">
            <span>{item.question}</span>
            <span aria-hidden="true" className="text-accent mt-0.5 font-serif text-2xl leading-none group-open:hidden">
              +
            </span>
            <span aria-hidden="true" className="text-accent mt-0.5 hidden font-serif text-2xl leading-none group-open:inline">
              −
            </span>
          </summary>
          <p className="text-muted max-w-prose pb-6 leading-8">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}

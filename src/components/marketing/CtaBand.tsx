import type { ReactNode } from "react";

import { containerClass } from "@/components/marketing/classes";

/** The closing call to action of a marketing page: a heading, a line, the actions and a small note. */
export function CtaBand({
  id,
  title,
  body,
  note,
  children,
}: {
  id: string;
  title: string;
  body?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="border-t border-border bg-accent-soft">
      <div className={`${containerClass} py-16 text-center sm:py-24`}>
        <h2 id={`${id}-titulo`} className="mx-auto max-w-3xl font-serif text-3xl leading-tight tracking-tight text-balance sm:text-5xl">
          {title}
        </h2>
        {body ? <p className="text-muted mx-auto mt-5 max-w-xl text-lg leading-8">{body}</p> : null}
        <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">{children}</div>
        {note ? <p className="text-muted mt-6 text-sm">{note}</p> : null}
      </div>
    </section>
  );
}

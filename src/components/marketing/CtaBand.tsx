import type { ReactNode } from "react";

import { containerClass, cx } from "@/components/marketing/classes";

/**
 * The closing call to action of a marketing page: a heading, a line, the actions and a small note.
 *
 * With `photo` (MKT-5, a decorative `LifestylePhoto`), the band turns
 * editorial: the text moves to the left and the photo enters from the right
 * edge, fading into the band so it never sits behind the text (on phones: a
 * strip above the heading, fading down).
 */
export function CtaBand({
  id,
  title,
  body,
  note,
  photo,
  children,
}: {
  id: string;
  title: string;
  body?: string;
  note?: string;
  photo?: ReactNode;
  children: ReactNode;
}) {
  const hasPhoto = Boolean(photo);
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className={cx("border-t border-border bg-accent-soft", hasPhoto && "relative overflow-hidden")}>
      {hasPhoto ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-52 [mask-image:linear-gradient(to_bottom,#000_35%,transparent)] sm:h-64 lg:inset-y-0 lg:left-auto lg:h-auto lg:w-[46%] lg:[mask-image:linear-gradient(to_right,transparent,#000_40%)]"
        >
          {photo}
        </div>
      ) : null}
      <div className={cx(containerClass, "relative py-16 sm:py-24", hasPhoto ? "pt-48 sm:pt-60 lg:pt-28 lg:pb-28" : "text-center")}>
        <div className={cx(hasPhoto && "text-center lg:w-[52%] lg:text-left")}>
          <h2
            id={`${id}-titulo`}
            className={cx("max-w-3xl font-serif text-3xl leading-tight tracking-tight text-balance sm:text-5xl", hasPhoto ? "mx-auto lg:mx-0" : "mx-auto")}
          >
            {title}
          </h2>
          {body ? <p className={cx("text-muted mt-5 max-w-xl text-lg leading-8", hasPhoto ? "mx-auto lg:mx-0" : "mx-auto")}>{body}</p> : null}
          <div className={cx("mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center", hasPhoto && "lg:justify-start")}>
            {children}
          </div>
          {note ? <p className="text-muted mt-6 text-sm">{note}</p> : null}
        </div>
      </div>
    </section>
  );
}

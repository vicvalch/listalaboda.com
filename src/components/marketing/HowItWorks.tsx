import { containerClass, cx } from "@/components/marketing/classes";
import { getMessages } from "@/lib/i18n";

type Audience = "planner" | "couple";

/**
 * "Cómo funciona" (ACCOUNT-01): the one section both landings share, with
 * both account paths, the page's own audience first (the header links both
 * pages). `id="como-funciona"` is what the header's "Cómo funciona" and the
 * hero buttons scroll to, on either page. Static, no client JS.
 */
export function HowItWorks({ first, className }: { first: Audience; className?: string }) {
  const copy = getMessages().marketing.howItWorks;
  const order: readonly Audience[] = first === "planner" ? ["planner", "couple"] : ["couple", "planner"];

  return (
    <section
      id="como-funciona"
      aria-labelledby="como-funciona-titulo"
      data-testid="how-it-works"
      className={cx("scroll-mt-20 border-t border-border", className)}
    >
      <div className={cx(containerClass, "py-14 sm:py-20")}>
        <div className="max-w-2xl space-y-5">
          <p className="text-accent text-sm font-semibold tracking-[0.16em] uppercase">{copy.eyebrow}</p>
          <h2
            id="como-funciona-titulo"
            className="font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl"
          >
            {copy.title}
          </h2>
          <p className="text-muted max-w-prose text-lg leading-8">{copy.body}</p>
        </div>
        <div className="mt-10 grid gap-12 sm:mt-14 md:grid-cols-2 md:gap-10">
          {order.map((audience) => {
            const path = copy[audience];
            return (
              <div key={audience} data-audience={audience} className="space-y-6">
                <h3 className="font-serif text-2xl leading-snug sm:text-3xl">{path.title}</h3>
                <ol className="divide-y divide-border border-y border-border">
                  {path.steps.map((step, stepIndex) => (
                    <li key={step} className="flex items-baseline gap-5 py-4">
                      <span aria-hidden="true" className="text-accent w-6 shrink-0 font-serif text-3xl leading-none">
                        {stepIndex + 1}
                      </span>
                      <span className="text-lg leading-7">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

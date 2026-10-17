import { containerClass, cx } from "@/components/marketing/classes";
import { primaryButtonClass } from "@/components/ui/styles";
import { PLAN_DISPLAY_PRICES } from "@/lib/billing/display-prices";
import { getMessages } from "@/lib/i18n";
import { MARKETING_LINKS } from "@/lib/marketing/links";

/**
 * The pricing section of a marketing page (BILLING-02 / MKT-7): one plan,
 * set like the rest of the page (eyebrow, serif heading, quiet text on the
 * left; the price large in serif and what it includes as a ruled list on the
 * right), never a row of SaaS cards.
 *
 * The amount comes from the display prices (`@/lib/billing/display-prices`),
 * the copy from `es.marketing.pricing`; what is charged is the configured
 * Stripe Price. The call to action is the login → billing entry
 * (`MARKETING_LINKS.START_BILLING`). Static: no session, no Stripe.
 */
export function PricingSection({ audience }: { audience: "planner" | "couple" }) {
  const { pricing } = getMessages().marketing;
  const copy = pricing[audience];
  const price = PLAN_DISPLAY_PRICES[audience];
  const cadence = audience === "planner" ? pricing.planner.cadence : null;

  return (
    <section
      id="precio"
      aria-labelledby="precio-titulo"
      data-pricing={audience}
      className="scroll-mt-20 border-t border-border bg-surface"
    >
      <div className={cx(containerClass, "grid gap-10 py-14 sm:py-20 lg:grid-cols-12 lg:gap-10")}>
        <div className="space-y-5 lg:col-span-5">
          <p className="text-accent text-sm font-semibold tracking-[0.16em] uppercase">{copy.eyebrow}</p>
          <h2
            id="precio-titulo"
            className="font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl"
          >
            {copy.title}
          </h2>
          <p className="text-muted max-w-prose text-lg leading-8">{copy.body}</p>
        </div>

        <div className="space-y-8 lg:col-span-6 lg:col-start-7">
          <div className="border-accent/30 border-y py-6">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="pricing-price">
              <span className="font-serif text-6xl leading-none tracking-tight sm:text-7xl">{price.amount}</span>
              <span className="text-lg font-semibold">{price.currency}</span>
              {cadence ? <span className="text-muted text-lg">{cadence}</span> : null}
            </p>
            <p className="text-accent mt-3 text-sm font-semibold tracking-[0.16em] uppercase">{copy.cadenceLabel}</p>
          </div>

          <ul aria-label={copy.featuresLabel} className="grid gap-x-8 sm:grid-cols-2">
            {copy.features.map((feature) => (
              <li key={feature} className="flex gap-3 border-b border-border py-3 leading-7">
                <span aria-hidden="true" className="text-accent font-serif leading-7">
                  —
                </span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>

          <div className="space-y-4">
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-5">
              <a href={MARKETING_LINKS.START_BILLING} className={primaryButtonClass}>
                {copy.cta}
              </a>
              <p className="text-muted text-sm font-semibold">{copy.note}</p>
            </div>
            <p className="text-muted text-sm">{pricing.promoNote}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

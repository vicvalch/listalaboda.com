import type { Metadata } from "next";

import { containerClass, cx, sectionSpacingClass } from "@/components/marketing/classes";
import { CtaBand } from "@/components/marketing/CtaBand";
import { ProductShot } from "@/components/marketing/ProductShot";
import { Section } from "@/components/marketing/Section";
import { ThemeShowcase } from "@/components/marketing/ThemeShowcase";
import { primaryButtonClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { MARKETING_LINKS } from "@/lib/marketing/links";
import { marketingMetadata } from "@/lib/marketing/metadata";

import budgetMobileShot from "../../../public/marketing/budget-mobile.webp";
import budgetShot from "../../../public/marketing/budget.webp";
import guestsMobileShot from "../../../public/marketing/guests-mobile.webp";
import guestsShot from "../../../public/marketing/guests.webp";
import myWeddingsMobileShot from "../../../public/marketing/mis-bodas-mobile.webp";
import myWeddingsShot from "../../../public/marketing/mis-bodas.webp";
import seatingMobileShot from "../../../public/marketing/seating-mobile.webp";
import seatingShot from "../../../public/marketing/seating.webp";
import timelineMobileShot from "../../../public/marketing/timeline-mobile.webp";
import timelineShot from "../../../public/marketing/timeline.webp";
import weddingCardMobileShot from "../../../public/marketing/wedding-card-mobile.webp";
import weddingCardShot from "../../../public/marketing/wedding-card.webp";

const { marketing } = getMessages();
const copy = marketing.home;

/**
 * Marketing Landing V1 homepage: planner-first. Not indexed yet (the
 * production domain isn't connected; no canonical is set until it is).
 */
export const metadata: Metadata = marketingMetadata(copy.metadata);

/** The four workflow rows; the wide seating planner gets the full column. */
const WORKFLOWS = [
  { key: "guests", image: guestsShot, mobile: guestsMobileShot, layout: "text-first" },
  { key: "seating", image: seatingShot, mobile: seatingMobileShot, layout: "stacked" },
  { key: "budget", image: budgetShot, mobile: budgetMobileShot, layout: "visual-first" },
  { key: "timeline", image: timelineShot, mobile: timelineMobileShot, layout: "text-first" },
] as const;

export default function HomePage() {
  return (
    <>
      {/* 1. Hero: the promise for planners, then the real "Mis bodas". */}
      <div className={cx(containerClass, "pt-12 pb-16 sm:pt-20 sm:pb-24")}>
        <Section
          eyebrow={copy.hero.eyebrow}
          title={copy.hero.title}
          headingLevel={1}
          body={copy.hero.body}
          actions={
            <div className="space-y-5">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <a href={MARKETING_LINKS.DEMO} className={primaryButtonClass}>
                  {marketing.cta.demo}
                </a>
                <a href={MARKETING_LINKS.HOW_IT_WORKS} className={secondaryButtonClass}>
                  {marketing.cta.howItWorks}
                </a>
              </div>
              <p className="text-muted text-sm">
                {copy.hero.couples}{" "}
                <a href={MARKETING_LINKS.COUPLES} className={textLinkClass}>
                  {copy.hero.couplesLink} <span aria-hidden="true">→</span>
                </a>
              </p>
            </div>
          }
          visual={
            <ProductShot
              image={myWeddingsShot}
              mobile={myWeddingsMobileShot}
              alt={copy.hero.shotAlt}
              priority
            />
          }
        />
      </div>

      {/* 2. The problem: typographic, no visual. */}
      <div className="border-t border-border">
        <div className={cx(containerClass, sectionSpacingClass)}>
          <Section id="problema" eyebrow={copy.problem.eyebrow} title={copy.problem.title} body={copy.problem.body} />
        </div>
      </div>

      {/* 3. What needs attention, across weddings. */}
      <div className="border-t border-border">
        <div className={cx(containerClass, sectionSpacingClass)}>
          <Section
            id="atencion"
            eyebrow={copy.attention.eyebrow}
            title={copy.attention.title}
            body={copy.attention.body}
            layout="text-first"
            actions={
              <a href={MARKETING_LINKS.PLANNERS} className={textLinkClass}>
                {copy.attention.more} <span aria-hidden="true">→</span>
              </a>
            }
            visual={<ProductShot image={weddingCardShot} mobile={weddingCardMobileShot} alt={copy.attention.shotAlt} />}
          />
        </div>
      </div>

      {/* 4. The core workflows: four alternating editorial rows. */}
      <div className="border-t border-border">
        <div className={cx(containerClass, sectionSpacingClass)}>
          <Section id="flujos" eyebrow={copy.workflows.eyebrow} title={copy.workflows.title}>
            <div className="divide-y divide-border">
              {WORKFLOWS.map(({ key, image, mobile, layout }) => {
                const row = copy.workflows.rows[key];
                return (
                  <div key={key} className="py-12 first:pt-2 last:pb-0 sm:py-16">
                    <Section
                      id={`flujo-${key}`}
                      title={row.title}
                      headingLevel={3}
                      body={row.body}
                      layout={layout}
                      visual={
                        <ProductShot
                          image={image}
                          mobile={mobile}
                          alt={row.shotAlt}
                        />
                      }
                    />
                  </div>
                );
              })}
            </div>
          </Section>
        </div>
      </div>

      {/* 5. A wedding site for each couple: the real themes. */}
      <div className="border-t border-border">
        <div className={cx(containerClass, sectionSpacingClass)}>
          <Section
            id="sitios-de-boda"
            eyebrow={copy.weddingSites.eyebrow}
            title={copy.weddingSites.title}
            body={copy.weddingSites.body}
          >
            <ThemeShowcase label={copy.weddingSites.showcaseLabel} />
          </Section>
        </div>
      </div>

      {/* 6. How it works: three steps, text only. */}
      <div className="border-t border-border">
        <div className={cx(containerClass, sectionSpacingClass)}>
          <Section id="como-funciona" title={copy.howItWorks.title}>
            <ol className="grid gap-10 sm:grid-cols-3 sm:gap-8">
              {copy.howItWorks.steps.map((step, index) => (
                <li key={step.title} className="space-y-3 border-t border-border pt-6">
                  <p aria-hidden="true" className="text-accent font-serif text-4xl">
                    {index + 1}
                  </p>
                  <h3 className="text-lg font-semibold">{step.title}</h3>
                  <p className="text-muted leading-7">{step.body}</p>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {/* 7. Closing call to action. */}
      <CtaBand id="empezar" title={copy.closing.title} body={copy.closing.body} note={copy.closing.note}>
        <a href={MARKETING_LINKS.DEMO} className={primaryButtonClass}>
          {marketing.cta.demo}
        </a>
        <a href={MARKETING_LINKS.PILOT} className={secondaryButtonClass}>
          {marketing.cta.pilot}
        </a>
      </CtaBand>
    </>
  );
}

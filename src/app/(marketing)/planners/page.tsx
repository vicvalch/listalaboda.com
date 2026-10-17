import type { Metadata } from "next";

import { containerClass, cx } from "@/components/marketing/classes";
import { FaqList } from "@/components/marketing/FaqList";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { LifestylePhoto } from "@/components/marketing/LifestylePhoto";
import { PricingSection } from "@/components/marketing/PricingSection";
import { ProductShot } from "@/components/marketing/ProductShot";
import { ThemeShowcase } from "@/components/marketing/ThemeShowcase";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { displayPrice } from "@/lib/billing/display-prices";
import { getMessages } from "@/lib/i18n";
import { MARKETING_LINKS } from "@/lib/marketing/links";
import { marketingMetadata } from "@/lib/marketing/metadata";

import weddingDaySmallPhoto from "../../../../public/marketing/lifestyle/planner-decisive-moment-sm.webp";
import weddingDayPhoto from "../../../../public/marketing/lifestyle/planner-decisive-moment.webp";
import plannerSmallPhoto from "../../../../public/marketing/lifestyle/planner-with-couple-sm.webp";
import plannerPhoto from "../../../../public/marketing/lifestyle/planner-with-couple.webp";
import budgetMobileShot from "../../../../public/marketing/budget-mobile.webp";
import budgetShot from "../../../../public/marketing/budget.webp";
import guestsMobileShot from "../../../../public/marketing/guests-mobile.webp";
import guestsShot from "../../../../public/marketing/guests.webp";
import myWeddingsMobileShot from "../../../../public/marketing/mis-bodas-mobile.webp";
import myWeddingsShot from "../../../../public/marketing/mis-bodas.webp";
import seatingMobileShot from "../../../../public/marketing/seating-mobile.webp";
import seatingShot from "../../../../public/marketing/seating.webp";
import timelinePrint1 from "../../../../public/marketing/timeline-print-1.webp";
import timelinePrint2 from "../../../../public/marketing/timeline-print-2.webp";
import timelinePrint3 from "../../../../public/marketing/timeline-print-3.webp";
import vendorPaymentsMobileShot from "../../../../public/marketing/vendor-payments-mobile.webp";
import vendorPaymentsShot from "../../../../public/marketing/vendor-payments.webp";
import weddingCardShot from "../../../../public/marketing/wedding-card.webp";

const { marketing } = getMessages();
const copy = marketing.planners;

/**
 * Marketing Landing V1, MKT-2: the page for wedding planners, and the
 * default commercial entry (`/` redirects here, ACCOUNT-01). Static; not
 * indexed yet and without a canonical until the production domain is
 * connected.
 *
 * One visual narrative built from real product screens (fictional fixture):
 * every wedding and what needs attention (right under the hero), from the
 * RSVP to the table, the money, the printed day, then the couple's site and
 * the pilot. Screens whose own page background matches this page sit
 * unframed in the composition; a shadow remains only where one screen is
 * laid over another.
 *
 * MKT-6: two photographs carry the human side: plan (the hero, the planner
 * with the couple) and be there when it matters (after the Cronograma, the
 * planner with the bride before the ceremony). Never beside the guests or
 * money screens. The pilot band gets warm light, not another photo.
 */
export const metadata: Metadata = marketingMetadata(copy.metadata);

/** BILLING-02: the price answer quotes the display price (`{price}`), never a second copy of it. */
const faqItems = copy.faq.items.map((item) => ({ ...item, answer: item.answer.replace("{price}", displayPrice("planner")) }));

const TIMELINE_SHOTS = [timelinePrint1, timelinePrint2, timelinePrint3] as const;

const eyebrowClass = "text-accent text-sm font-semibold tracking-[0.16em] uppercase";
const h2Class = "font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl";
/** This page's section rhythm: tighter than the homepage, the visuals carry the space. */
const spacingClass = "py-14 sm:py-20";

/** Eyebrow and heading on the left, the short text (and an optional note) on the right; stacked on phones. */
function SplitHeader({
  id,
  eyebrow,
  title,
  body,
  note,
}: {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  note?: string;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-12 lg:items-end lg:gap-10">
      <div className="space-y-5 lg:col-span-7">
        <p className={eyebrowClass}>{eyebrow}</p>
        <h2 id={`${id}-titulo`} className={h2Class}>
          {title}
        </h2>
      </div>
      <div className="space-y-4 lg:col-span-5">
        <p className="text-muted max-w-prose text-lg leading-8">{body}</p>
        {note ? <p className="border-accent border-l-2 pl-4 text-sm leading-6 font-semibold">{note}</p> : null}
      </div>
    </div>
  );
}

function PilotActions() {
  return (
    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <a href={MARKETING_LINKS.PILOT} className={primaryButtonClass}>
        {marketing.cta.pilot}
      </a>
      <a href={MARKETING_LINKS.DEMO} className={secondaryButtonClass}>
        {marketing.cta.demo}
      </a>
    </div>
  );
}

export default function PlannersPage() {
  return (
    <>
      {/* 1. Hero: the statement beside the planner with a couple, entering
          from the right edge; on wide screens one wedding's card laid over the
          photo's corner. Then "Mis bodas" as the proof under it. */}
      <div className="overflow-x-clip">
        <section id="inicio" aria-labelledby="inicio-titulo" className={cx(containerClass, "pt-10 pb-14 sm:pt-16 sm:pb-20")}>
          <div className="grid gap-10 lg:grid-cols-12 lg:items-center lg:gap-x-10">
            <div className="relative z-10 space-y-6 lg:col-span-5">
              <p className={eyebrowClass}>{copy.hero.eyebrow}</p>
              <h1
                id="inicio-titulo"
                className="font-serif text-[2.6rem] leading-[1.05] tracking-tight text-balance sm:text-6xl xl:text-[4.25rem]"
              >
                {copy.hero.title}
              </h1>
              <p className="text-muted max-w-prose text-lg leading-8">{copy.hero.body}</p>
              <div className="space-y-4 pt-2">
                <PilotActions />
                <p className="text-muted text-sm">{copy.hero.support}</p>
              </div>
            </div>
            <div className="relative lg:col-span-7">
              <LifestylePhoto
                image={plannerPhoto}
                small={plannerSmallPhoto}
                alt={copy.hero.photoAlt}
                priority
                sizes="(min-width: 1024px) 65vw, 100vw"
                position="object-[38%_center] lg:object-[30%_center]"
                className="relative -mr-4 aspect-[4/3] rounded-l-[2.5rem] sm:-mr-6 sm:aspect-[16/10] lg:-mr-40 lg:aspect-[6/5] lg:rounded-l-[5rem] xl:-mr-64"
              />
              {/* From the people to the work: the card of the first wedding needing attention. */}
              <ProductShot
                image={weddingCardShot}
                alt={copy.hero.cardAlt}
                frame="lifted"
                className="absolute -bottom-16 -left-10 z-10 hidden w-[22rem] lg:block xl:-left-16 xl:w-[24rem]"
              />
            </div>
          </div>
          {/* Every wedding and what needs attention: the product, as proof. */}
          <ProductShot
            image={myWeddingsShot}
            mobile={myWeddingsMobileShot}
            alt={copy.hero.shotAlt}
            caption={copy.hero.shotCaption}
            fade
            frame="none"
            frameClassName="max-h-[26rem] sm:max-h-[34rem] dark:rounded-xl"
            className="mt-12 sm:mt-16 lg:mt-36"
          />
        </section>
      </div>

      {/* 2. The problem: typography and space only. */}
      <section id="problema" aria-labelledby="problema-titulo" className="border-t border-border">
        <div className={cx(containerClass, spacingClass, "space-y-8")}>
          <p className={eyebrowClass}>{copy.problem.eyebrow}</p>
          <h2 id="problema-titulo" className={h2Class}>
            {copy.problem.title}
          </h2>
          <ul
            aria-label={copy.problem.toolsLabel}
            className="text-muted flex flex-wrap gap-x-6 gap-y-1 font-serif text-2xl sm:gap-x-10 sm:text-4xl"
          >
            {copy.problem.tools.map((tool) => (
              <li key={tool} className="line-through decoration-accent/70 decoration-2">
                {tool}
              </li>
            ))}
          </ul>
          <p className="max-w-2xl text-xl leading-9 sm:text-2xl sm:leading-10">{copy.problem.body}</p>
        </div>
      </section>

      {/* How it works (ACCOUNT-01): both account paths, the planner's first. */}
      <HowItWorks first="planner" />

      {/* 3. From the RSVP to the table: one party's answers laid over the
          planner where the same guests are seated (or still waiting). */}
      <section
        id="invitados-y-mesas"
        aria-labelledby="invitados-y-mesas-titulo"
        className="scroll-mt-20 border-t border-border bg-surface"
      >
        <div className={cx(containerClass, "grid gap-8 pt-14 sm:pt-20 lg:grid-cols-12 lg:items-end lg:gap-10")}>
          {/* lg:pb-32 clears the planner, which rises under the party card. */}
          <div className="space-y-5 lg:col-span-5 lg:pb-32">
            <p className={eyebrowClass}>{copy.guestsSeating.eyebrow}</p>
            <h2 id="invitados-y-mesas-titulo" className={h2Class}>
              {copy.guestsSeating.title}
            </h2>
            <p className="text-muted max-w-prose text-lg leading-8">{copy.guestsSeating.body}</p>
            <p className="border-accent border-l-2 pl-4 text-sm leading-6 font-semibold">{copy.guestsSeating.note}</p>
          </div>
          {/* The party's answers, laid over the top edge of the planner below (wide screens). */}
          <ProductShot
            image={guestsShot}
            mobile={guestsMobileShot}
            alt={copy.guestsSeating.guestsAlt}
            frame="lifted"
            fade
            frameClassName="max-h-[22rem] sm:max-h-none sm:[mask-image:none]"
            className="relative z-10 lg:col-span-6 lg:col-start-7 lg:-mb-24"
          />
        </div>
        <div className="mx-auto w-full max-w-7xl px-4 pt-6 pb-14 sm:px-6 sm:pt-10 sm:pb-20 lg:pt-0">
          <ProductShot image={seatingShot} mobile={seatingMobileShot} alt={copy.guestsSeating.seatingAlt} />
        </div>
      </section>

      {/* 4. Money: the budget unframed, one vendor's payments laid over it. */}
      <section id="presupuesto" aria-labelledby="presupuesto-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, spacingClass, "space-y-10 sm:space-y-14")}>
          <SplitHeader
            id="presupuesto"
            eyebrow={copy.money.eyebrow}
            title={copy.money.title}
            body={copy.money.body}
            note={copy.money.note}
          />
          <div className="grid gap-6 lg:grid-cols-12 lg:gap-0">
            <ProductShot
              image={budgetShot}
              mobile={budgetMobileShot}
              alt={copy.money.budgetAlt}
              fade
              frame="none"
              frameClassName="max-h-[22rem] sm:max-h-[34rem] dark:rounded-xl"
              className="lg:col-span-8 lg:col-start-1 lg:row-start-1"
            />
            <ProductShot
              image={vendorPaymentsShot}
              mobile={vendorPaymentsMobileShot}
              alt={copy.money.paymentsAlt}
              fade
              frame="lifted"
              frameClassName="max-h-[24rem] sm:max-h-[34rem]"
              className="relative lg:col-span-6 lg:col-start-7 lg:row-start-1 lg:mt-28"
            />
          </div>
        </div>
      </section>

      {/* 5. The Cronograma as the product prints it: one sheet, the day
          unfolding left to right in three runs. */}
      <section id="cronograma" aria-labelledby="cronograma-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, spacingClass, "space-y-10 sm:space-y-14")}>
          <SplitHeader id="cronograma" eyebrow={copy.timeline.eyebrow} title={copy.timeline.title} body={copy.timeline.body} />
          <div
            role="region"
            aria-label={copy.timeline.label}
            tabIndex={0}
            className="-mx-4 snap-x snap-mandatory overflow-x-auto px-4 pb-3 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0"
          >
            {/* Paper stays white in both color schemes, like the printout. */}
            <ol className="flex w-max overflow-hidden rounded-lg border-t-4 border-accent bg-white shadow-[0_2px_4px_rgb(42_34_32/0.06),0_24px_48px_-24px_rgb(42_34_32/0.3)] sm:grid sm:w-full sm:grid-cols-3">
              {TIMELINE_SHOTS.map((shot, index) => (
                <li key={shot.src} className="w-[17rem] shrink-0 snap-start py-2 sm:w-auto">
                  <ProductShot image={shot} alt={copy.timeline.shots[index]} frame="none" />
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* 6. The wedding day: the page's human moment, right after the plan for
          it. The planner with the bride, entering from the left edge on phones. */}
      <section id="el-dia" aria-labelledby="el-dia-titulo" className="scroll-mt-20 overflow-x-clip border-t border-border">
        <div className={cx(containerClass, spacingClass, "grid gap-10 lg:grid-cols-12 lg:items-center lg:gap-x-12")}>
          <div className="space-y-5 lg:col-span-5 lg:col-start-8 lg:row-start-1">
            <p className={eyebrowClass}>{copy.weddingDay.eyebrow}</p>
            <h2 id="el-dia-titulo" className={h2Class}>
              {copy.weddingDay.title}
            </h2>
            <p className="text-muted max-w-prose text-lg leading-8">{copy.weddingDay.body}</p>
          </div>
          {/* The source's own 4:3, never cropped: both faces and the veil stay whole. */}
          <LifestylePhoto
            image={weddingDayPhoto}
            small={weddingDaySmallPhoto}
            alt={copy.weddingDay.photoAlt}
            sizes="(min-width: 1024px) 58vw, 100vw"
            className="mkt-reveal relative -ml-4 aspect-[4/3] rounded-r-[2.5rem] sm:-ml-6 lg:col-span-7 lg:col-start-1 lg:row-start-1 lg:ml-0 lg:rounded-l-xl lg:rounded-r-[5rem]"
          />
        </div>
      </section>

      {/* 7. Collaboration: who works on each wedding, and who publishes. */}
      <section id="colaboracion" aria-labelledby="colaboracion-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, spacingClass, "grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10")}>
          <div className="space-y-5 lg:col-span-5">
            <p className={eyebrowClass}>{copy.collaboration.eyebrow}</p>
            <h2 id="colaboracion-titulo" className={h2Class}>
              {copy.collaboration.title}
            </h2>
          </div>
          <ul className="divide-y divide-border border-y border-border lg:col-span-7">
            {copy.collaboration.points.map((point) => (
              <li key={point.title} className="py-5 sm:flex sm:items-baseline sm:gap-6">
                <h3 className="font-serif text-2xl leading-snug sm:w-1/2 sm:shrink-0">{point.title}</h3>
                <p className="text-muted mt-1 leading-7 sm:mt-0">{point.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 8. A site for each couple: the five real themes as the finale, wide and staggered. */}
      <section id="sitios-de-boda" aria-labelledby="sitios-de-boda-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, "pt-14 sm:pt-20")}>
          <div className="grid gap-5 lg:grid-cols-12 lg:items-end lg:gap-10">
            <div className="space-y-5 lg:col-span-7">
              <p className={eyebrowClass}>{copy.sites.eyebrow}</p>
              <h2 id="sitios-de-boda-titulo" className={h2Class}>
                {copy.sites.title}
              </h2>
            </div>
            <p className="text-muted max-w-prose text-lg leading-8 lg:col-span-5">{copy.sites.body}</p>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[88rem] px-4 pt-10 pb-14 sm:px-6 sm:pt-14 sm:pb-20">
          <ThemeShowcase label={copy.sites.showcaseLabel} staggered />
        </div>
      </section>

      {/* BILLING-02 / MKT-7: the price, evergreen (no promotion advertised); its call to action enters billing. */}
      <PricingSection audience="planner" />

      {/* 9. Questions: a quiet block before the last word. */}
      <section id="preguntas" aria-labelledby="preguntas-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, spacingClass, "grid gap-8 lg:grid-cols-12 lg:gap-10")}>
          <h2 id="preguntas-titulo" className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl lg:col-span-4">
            {copy.faq.title}
          </h2>
          <div className="lg:col-span-8">
            <FaqList items={faqItems} />
          </div>
        </div>
      </section>

      {/* 10. The pilot: the page's one conversion band, and its last word. */}
      <section id="pilot" aria-labelledby="pilot-titulo" className="relative scroll-mt-20 overflow-hidden border-t border-border bg-accent-soft">
        {/* Warm light from the upper right: decoration only. */}
        <div
          aria-hidden="true"
          className="mkt-float pointer-events-none absolute -top-40 -right-40 h-[32rem] w-[32rem] rounded-full bg-[radial-gradient(closest-side,var(--mkt-glow),transparent)] sm:h-[44rem] sm:w-[44rem]"
        />
        <div className={cx(containerClass, "relative grid gap-10 py-16 sm:py-24 lg:grid-cols-12 lg:gap-10")}>
          <div className="space-y-6 lg:col-span-7">
            <p className={eyebrowClass}>{copy.pilot.eyebrow}</p>
            <h2 id="pilot-titulo" className="font-serif text-4xl leading-tight tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {copy.pilot.title}
            </h2>
            <p className="text-muted max-w-prose text-lg leading-8">{copy.pilot.body}</p>
            <div className="pt-2">
              <PilotActions />
            </div>
          </div>
          <div className="space-y-6 lg:col-span-4 lg:col-start-9 lg:self-end">
            <ol className="space-y-5">
              {copy.pilot.steps.map((step, index) => (
                <li key={step} className="flex gap-5 border-t border-accent/30 pt-5">
                  <span aria-hidden="true" className="text-accent font-serif text-3xl leading-none">
                    {index + 1}
                  </span>
                  <span className="text-lg leading-7">{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-muted text-sm">{copy.pilot.note}</p>
          </div>
        </div>
      </section>
    </>
  );
}

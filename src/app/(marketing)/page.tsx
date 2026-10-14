import type { Metadata } from "next";

import { containerClass, cx } from "@/components/marketing/classes";
import { CtaBand } from "@/components/marketing/CtaBand";
import { LifestylePhoto } from "@/components/marketing/LifestylePhoto";
import { ProductShot } from "@/components/marketing/ProductShot";
import { ThemeShowcase } from "@/components/marketing/ThemeShowcase";
import { primaryButtonClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { MARKETING_LINKS } from "@/lib/marketing/links";
import { marketingMetadata } from "@/lib/marketing/metadata";

import coupleSmallPhoto from "../../../public/marketing/lifestyle/couple-golden-hour-sm.webp";
import couplePhoto from "../../../public/marketing/lifestyle/couple-golden-hour.webp";
import floralSmallPhoto from "../../../public/marketing/lifestyle/floral-sunset-sm.webp";
import floralPhoto from "../../../public/marketing/lifestyle/floral-sunset.webp";
import tablescapeSmallPhoto from "../../../public/marketing/lifestyle/tablescape-candles-sm.webp";
import tablescapePhoto from "../../../public/marketing/lifestyle/tablescape-candles.webp";
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
 * Marketing Landing V1 homepage: the short, planner-first overview (MKT-1,
 * recomposed in MKT-4A). Not indexed yet (the production domain isn't
 * connected; no canonical is set until it is).
 *
 * Seven sections, each real screen once: every wedding with one of them laid
 * over it (hero), the problem in type only, two compositions for the work
 * (guests → tables, money → the day), the couple's site as the bridge to
 * /parejas, the three steps and the call to action. The detail lives on
 * /planners and /parejas.
 *
 * MKT-5 adds the wedding itself, around the product and never instead of it:
 * candlelight in the hero's wash, the couple beside their site, and flowers
 * at sunset in the closing band. No photographs in the work sections.
 */
export const metadata: Metadata = marketingMetadata(copy.metadata);

const eyebrowClass = "text-accent text-sm font-semibold tracking-[0.16em] uppercase";
const h2Class = "font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl";
const bodyClass = "text-muted max-w-prose text-lg leading-8";
/** The section rhythm shared with /planners and /parejas. */
const spacingClass = "py-14 sm:py-20";

/** Eyebrow, heading and one sentence: the whole text of a homepage section. */
function SectionText({ id, eyebrow, title, body }: { id: string; eyebrow: string; title: string; body: string }) {
  return (
    <div className="max-w-2xl space-y-5">
      <p className={eyebrowClass}>{eyebrow}</p>
      <h2 id={`${id}-titulo`} className={h2Class}>
        {title}
      </h2>
      <p className={bodyClass}>{body}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      {/* 1. Hero: the promise, then "Mis bodas" on a wash that runs off the
          right edge, with one of those weddings laid across its foot. */}
      <div className="overflow-x-clip">
        <section
          id="inicio"
          aria-labelledby="inicio-titulo"
          className={cx(containerClass, "grid gap-12 pt-10 pb-14 sm:pt-16 sm:pb-20 lg:grid-cols-12 lg:items-center lg:gap-10 lg:pb-44")}
        >
          <div className="relative z-10 space-y-6 lg:col-span-5">
            <p className={eyebrowClass}>{copy.hero.eyebrow}</p>
            <h1
              id="inicio-titulo"
              className="font-serif text-[2.6rem] leading-[1.05] tracking-tight text-balance sm:text-6xl lg:text-7xl"
            >
              {copy.hero.title}
            </h1>
            <p className={bodyClass}>{copy.hero.body}</p>
            <div className="space-y-5 pt-2">
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
          </div>
          <div className="relative lg:col-span-7 lg:-mr-40 xl:-mr-64">
            {/* The wash runs past the page edge (the wrapper clips it): decoration only.
                Its foot is candlelight, under the list and beside the card (from small tablets up). */}
            <div
              aria-hidden="true"
              className="bg-accent-soft absolute top-14 -right-4 -bottom-8 -left-3 overflow-hidden rounded-l-[2rem] sm:-right-6 sm:-left-6 lg:top-16 lg:-right-96 lg:-bottom-40 lg:-left-8"
            >
              <LifestylePhoto
                image={tablescapePhoto}
                small={tablescapeSmallPhoto}
                alt=""
                sizes="100vw"
                position="object-[center_42%]"
                drift
                className="absolute inset-x-0 bottom-0 hidden h-[34%] [mask-image:linear-gradient(to_bottom,transparent,#000_55%)] sm:block lg:h-[40%]"
              />
            </div>
            <ProductShot
              image={myWeddingsShot}
              mobile={myWeddingsMobileShot}
              alt={copy.hero.shotAlt}
              priority
              fade
              frame="lifted"
              frameClassName="max-h-[22rem] bg-background sm:max-h-[34rem]"
              className="relative"
            />
            {/* From every wedding to one of them: its card, across the foot of the list. */}
            <ProductShot
              image={weddingCardShot}
              mobile={weddingCardMobileShot}
              alt={copy.hero.cardAlt}
              fade
              frame="lifted"
              frameClassName="max-h-[15rem] bg-background sm:max-h-none sm:[mask-image:none]"
              className="relative z-10 ml-auto -mt-8 w-[88%] sm:-mt-24 sm:w-[64%] lg:absolute lg:-bottom-36 lg:-left-16 lg:mt-0 lg:w-[50%]"
            />
          </div>
        </section>
      </div>

      {/* 2. The problem: type and space only. */}
      <section id="problema" aria-labelledby="problema-titulo" className="border-t border-border">
        <div className={cx(containerClass, spacingClass, "grid gap-6 lg:grid-cols-12 lg:items-end lg:gap-10")}>
          <div className="space-y-5 lg:col-span-7">
            <p className={eyebrowClass}>{copy.problem.eyebrow}</p>
            <h2 id="problema-titulo" className={h2Class}>
              {copy.problem.title}
            </h2>
          </div>
          <p className="max-w-prose text-xl leading-9 lg:col-span-5">{copy.problem.body}</p>
        </div>
      </section>

      {/* 3. Guests to tables: the planner, with one party's answers laid
          over its rail of guests still without a table. */}
      <section
        id="invitados-y-mesas"
        aria-labelledby="invitados-y-mesas-titulo"
        className="scroll-mt-20 border-t border-border bg-surface"
      >
        <div className={cx(containerClass, spacingClass)}>
          <SectionText
            id="invitados-y-mesas"
            eyebrow={copy.guestsSeating.eyebrow}
            title={copy.guestsSeating.title}
            body={copy.guestsSeating.body}
          />
          <div className="mt-10 grid gap-6 sm:mt-14 lg:grid-cols-12 lg:gap-0">
            <ProductShot
              image={guestsShot}
              mobile={guestsMobileShot}
              alt={copy.guestsSeating.guestsAlt}
              fade
              frame="lifted"
              frameClassName="max-h-[22rem] bg-background sm:max-h-none sm:[mask-image:none]"
              className="relative z-10 lg:col-span-5 lg:col-start-1 lg:row-start-1 lg:mt-48"
            />
            <ProductShot
              image={seatingShot}
              mobile={seatingMobileShot}
              alt={copy.guestsSeating.seatingAlt}
              className="lg:col-span-9 lg:col-start-4 lg:row-start-1"
            />
          </div>
        </div>
      </section>

      {/* 4. Money to the day: the budget, and the day's run of show crossing its foot. */}
      <section id="presupuesto-y-cronograma" aria-labelledby="presupuesto-y-cronograma-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, spacingClass)}>
          <div className="grid gap-5 lg:grid-cols-12 lg:items-end lg:gap-10">
            <div className="lg:col-span-8">
              <SectionText
                id="presupuesto-y-cronograma"
                eyebrow={copy.moneyDay.eyebrow}
                title={copy.moneyDay.title}
                body={copy.moneyDay.body}
              />
            </div>
            <p className="lg:col-span-4 lg:text-right">
              <a href={MARKETING_LINKS.PLANNERS} className={textLinkClass}>
                {copy.moneyDay.more} <span aria-hidden="true">→</span>
              </a>
            </p>
          </div>
          <div className="mt-10 grid gap-6 sm:mt-14 lg:grid-cols-12 lg:gap-0">
            <ProductShot
              image={budgetShot}
              mobile={budgetMobileShot}
              alt={copy.moneyDay.budgetAlt}
              fade
              frame="none"
              frameClassName="max-h-[20rem] sm:max-h-[30rem] dark:rounded-xl"
              className="lg:col-span-8 lg:col-start-1 lg:row-start-1"
            />
            <ProductShot
              image={timelineShot}
              mobile={timelineMobileShot}
              alt={copy.moneyDay.timelineAlt}
              fade
              frame="lifted"
              frameClassName="max-h-[20rem] bg-background sm:max-h-[26rem]"
              className="relative lg:col-span-7 lg:col-start-6 lg:row-start-1 lg:mt-52"
            />
          </div>
        </div>
      </section>

      {/* 5. The couple's side: their site, the bridge to /parejas. */}
      <section id="sitios-de-boda" aria-labelledby="sitios-de-boda-titulo" className="scroll-mt-20 overflow-x-clip border-t border-border">
        <div className={cx(containerClass, spacingClass)}>
          {/* The couple enters from the right edge, beside the words about their site. */}
          <div className="grid gap-10 lg:grid-cols-12 lg:items-center lg:gap-10">
            <div className="space-y-5 lg:col-span-6">
              <p className={eyebrowClass}>{copy.weddingSites.eyebrow}</p>
              <h2 id="sitios-de-boda-titulo" className={h2Class}>
                {copy.weddingSites.title}
              </h2>
              <p className={bodyClass}>{copy.weddingSites.body}</p>
              <p>
                <a href={MARKETING_LINKS.COUPLES} className={textLinkClass}>
                  {copy.weddingSites.couplesLink} <span aria-hidden="true">→</span>
                </a>
              </p>
            </div>
            <LifestylePhoto
              image={couplePhoto}
              small={coupleSmallPhoto}
              alt={copy.weddingSites.photoAlt}
              sizes="(min-width: 1024px) 62vw, 100vw"
              position="object-[22%_center]"
              className="mkt-reveal relative -mr-4 aspect-[16/10] rounded-l-[2.5rem] sm:-mr-6 lg:col-span-6 lg:-mr-40 lg:aspect-[4/3] lg:rounded-l-[5rem] xl:-mr-64"
            />
          </div>
          <div className="mt-10 sm:mt-14">
            <ThemeShowcase label={copy.weddingSites.showcaseLabel} />
          </div>
        </div>
      </section>

      {/* 6. How it works: three steps in large type between thin rules. */}
      <section id="como-funciona" aria-labelledby="como-funciona-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, spacingClass)}>
          <h2 id="como-funciona-titulo" className={h2Class}>
            {copy.howItWorks.title}
          </h2>
          <ol className="divide-border border-border mt-10 divide-y border-y sm:mt-12 md:grid md:grid-cols-3 md:divide-x md:divide-y-0">
            {copy.howItWorks.steps.map((step, index) => (
              <li key={step.title} className="flex gap-6 py-8 md:block md:px-8 md:first:pl-0 md:last:pr-0">
                <span aria-hidden="true" className="text-accent font-serif text-6xl leading-none sm:text-7xl">
                  {index + 1}
                </span>
                <div className="md:mt-8">
                  <h3 className="font-serif text-2xl leading-snug">{step.title}</h3>
                  <p className="text-muted mt-2 leading-7">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 7. Closing call to action. */}
      <CtaBand
        id="empezar"
        title={copy.closing.title}
        note={copy.closing.note}
        photo={
          <LifestylePhoto
            image={floralPhoto}
            small={floralSmallPhoto}
            alt=""
            sizes="(min-width: 1024px) 46vw, 100vw"
            position="object-[70%_center]"
            drift
            className="relative h-full w-full"
          />
        }
      >
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

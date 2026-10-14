import type { Metadata } from "next";

import { containerClass, cx } from "@/components/marketing/classes";
import { CtaBand } from "@/components/marketing/CtaBand";
import { FaqList } from "@/components/marketing/FaqList";
import { LifestylePhoto } from "@/components/marketing/LifestylePhoto";
import { ProductShot } from "@/components/marketing/ProductShot";
import { SiteRender } from "@/components/marketing/SiteRender";
import { ThemeShowcase } from "@/components/marketing/ThemeShowcase";
import { primaryButtonClass, secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { MARKETING_LINKS } from "@/lib/marketing/links";
import { marketingMetadata } from "@/lib/marketing/metadata";

import coupleSmallPhoto from "../../../../public/marketing/lifestyle/couple-golden-hour-sm.webp";
import couplePhoto from "../../../../public/marketing/lifestyle/couple-golden-hour.webp";
import floralSmallPhoto from "../../../../public/marketing/lifestyle/floral-sunset-sm.webp";
import floralPhoto from "../../../../public/marketing/lifestyle/floral-sunset.webp";
import tablescapeSmallPhoto from "../../../../public/marketing/lifestyle/tablescape-candles-sm.webp";
import tablescapePhoto from "../../../../public/marketing/lifestyle/tablescape-candles.webp";
import toastSmallPhoto from "../../../../public/marketing/lifestyle/wedding-toast-sm.webp";
import toastPhoto from "../../../../public/marketing/lifestyle/wedding-toast.webp";
import budgetMobileShot from "../../../../public/marketing/budget-mobile.webp";
import budgetShot from "../../../../public/marketing/budget.webp";
import checklistMobileShot from "../../../../public/marketing/checklist-mobile.webp";
import checklistShot from "../../../../public/marketing/checklist.webp";
import guestsMobileShot from "../../../../public/marketing/guests-mobile.webp";
import guestsShot from "../../../../public/marketing/guests.webp";
import seatingTablesShot from "../../../../public/marketing/seating-mobile.webp";
import timelineMobileShot from "../../../../public/marketing/timeline-mobile.webp";

const { marketing } = getMessages();
const copy = marketing.couples;

/**
 * Marketing Landing V1, MKT-3: the page for couples organizing their own
 * wedding. Static, like the other marketing pages; not indexed yet and
 * without a canonical until the production domain is connected.
 *
 * Warmer and shorter than /planners: it opens on the couple's own wedding
 * site (the real renderer) with a piece of their printed day, then walks the
 * day-to-day (what's next, guests to tables, money and the day) back to the
 * site as the centerpiece, and ends on planning together. No "Mis bodas":
 * several weddings are a planner's concern. Every screen is a real capture of
 * the fictional fixture; each one appears once on the page.
 *
 * MKT-5: the page with the most photography, and still never in place of a
 * screen: the couple behind their site (hero), candlelight under the
 * centerpiece, the toast as the payoff before the questions, and flowers at
 * sunset in the closing band. None next to money or the day's logistics.
 */
export const metadata: Metadata = marketingMetadata(copy.metadata);

const eyebrowClass = "text-accent text-sm font-semibold tracking-[0.16em] uppercase";
const h2Class = "font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl";
const bodyClass = "text-muted max-w-prose text-lg leading-8";
const noteClass = "border-accent border-l-2 pl-4 text-sm leading-6 font-semibold";

export default function CouplesPage() {
  return (
    <>
      {/* 1. Hero: the promise, then the couple entering from the right edge
          with their wedding site (the real Romantic theme) laid across its corner. */}
      <div className="overflow-x-clip">
        <section
          id="inicio"
          aria-labelledby="inicio-titulo"
          className={cx(containerClass, "grid gap-12 pt-10 pb-16 sm:pt-16 sm:pb-24 lg:grid-cols-12 lg:items-center lg:gap-10")}
        >
          <div className="relative z-10 space-y-6 lg:col-span-6">
            <p className={eyebrowClass}>{copy.hero.eyebrow}</p>
            <h1
              id="inicio-titulo"
              className="font-serif text-[2.5rem] leading-[1.05] tracking-tight text-balance sm:text-6xl lg:text-[4.25rem]"
            >
              {copy.hero.title}
            </h1>
            <p className={bodyClass}>{copy.hero.body}</p>
            <div className="space-y-5 pt-2">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <a href={MARKETING_LINKS.ACCESS} className={primaryButtonClass}>
                  {marketing.cta.access}
                </a>
                <a href="#como-funciona" className={secondaryButtonClass}>
                  {marketing.cta.howItWorks}
                </a>
              </div>
              <p className="text-muted text-sm">
                {copy.hero.plannerQuestion}{" "}
                <a href={MARKETING_LINKS.PLANNERS} className={textLinkClass}>
                  {copy.hero.plannerLink} <span aria-hidden="true">→</span>
                </a>
              </p>
            </div>
          </div>
          <div className="relative lg:col-span-6 lg:pb-10">
            {/* Warm light behind the composition: decoration only. */}
            <div
              aria-hidden="true"
              className="mkt-float pointer-events-none absolute -top-16 -left-10 h-80 w-80 rounded-full bg-[radial-gradient(closest-side,var(--mkt-glow),transparent)] lg:-top-24 lg:-left-24 lg:h-[30rem] lg:w-[30rem]"
            />
            <LifestylePhoto
              image={couplePhoto}
              small={coupleSmallPhoto}
              alt={copy.hero.photoAlt}
              sizes="(min-width: 1024px) 50vw, 100vw"
              position="object-[24%_center]"
              className="relative -mr-4 aspect-[16/11] rounded-l-[2.5rem] sm:-mr-6 lg:ml-[22%] lg:-mr-40 lg:aspect-[4/5] lg:rounded-l-[5rem] xl:-mr-64"
            />
            <SiteRender
              theme="romantic"
              scale="half"
              className="relative z-10 -mt-24 aspect-[4/5] w-[64%] max-w-[20rem] rounded-2xl shadow-[0_2px_4px_rgb(42_34_32/0.08),0_28px_56px_-20px_rgb(42_34_32/0.45)] sm:-mt-40 sm:w-[46%] lg:absolute lg:bottom-0 lg:-left-6 lg:mt-0 lg:w-[56%] lg:max-w-none"
            />
          </div>
        </section>
      </div>

      {/* 2. What's next: the wedding's home, calm and centered on a tinted band. */}
      <section id="como-funciona" aria-labelledby="como-funciona-titulo" className="scroll-mt-20 border-t border-border bg-surface">
        <div className={cx(containerClass, "py-14 sm:py-20")}>
          <div className="mx-auto max-w-3xl space-y-5 text-center">
            <p className={eyebrowClass}>{copy.checklist.eyebrow}</p>
            <h2 id="como-funciona-titulo" className={h2Class}>
              {copy.checklist.title}
            </h2>
            <p className={cx(bodyClass, "mx-auto")}>{copy.checklist.body}</p>
          </div>
          <ProductShot
            image={checklistShot}
            mobile={checklistMobileShot}
            alt={copy.checklist.shotAlt}
            frame="lifted"
            className="mx-auto mt-10 max-w-4xl sm:mt-14"
            frameClassName="bg-background"
          />
        </div>
      </section>

      {/* 3–4. From the answer to the table: the party's answers on the left,
          two of their tables lower on the right. */}
      <div className="border-t border-border">
        <div className={cx(containerClass, "grid gap-x-10 gap-y-12 py-14 sm:py-20 lg:grid-cols-12")}>
          <section id="invitados" aria-labelledby="invitados-titulo" className="scroll-mt-20 space-y-8 lg:col-span-6">
            <div className="space-y-5">
              <p className={eyebrowClass}>{copy.guests.eyebrow}</p>
              <h2 id="invitados-titulo" className={h2Class}>
                {copy.guests.title}
              </h2>
              <p className={bodyClass}>{copy.guests.body}</p>
              <p className={noteClass}>{copy.guests.note}</p>
            </div>
            <ProductShot image={guestsShot} mobile={guestsMobileShot} alt={copy.guests.shotAlt} frame="lifted" />
          </section>
          <section
            id="mesas"
            aria-labelledby="mesas-titulo"
            className="scroll-mt-20 space-y-8 lg:col-span-5 lg:col-start-8 lg:mt-56"
          >
            <ProductShot image={seatingTablesShot} alt={copy.seating.shotAlt} frame="card" className="sm:mx-auto sm:max-w-md lg:max-w-none" />
            <div className="space-y-5">
              <h2 id="mesas-titulo" className={h2Class}>
                {copy.seating.title}
              </h2>
              <p className={bodyClass}>{copy.seating.body}</p>
              <p className={noteClass}>{copy.seating.note}</p>
            </div>
          </section>
        </div>
      </div>

      {/* 5. Money and the day: the budget, and the day's timeline beside it. */}
      <section id="presupuesto" aria-labelledby="presupuesto-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, "py-14 sm:py-20")}>
          <div className="max-w-3xl space-y-5">
            <p className={eyebrowClass}>{copy.plan.eyebrow}</p>
            <h2 id="presupuesto-titulo" className={h2Class}>
              {copy.plan.title}
            </h2>
            <p className={bodyClass}>{copy.plan.body}</p>
            <p className={noteClass}>{copy.plan.note}</p>
          </div>
          <div className="mt-10 grid gap-6 sm:mt-14 lg:grid-cols-12 lg:gap-8">
            <ProductShot
              image={budgetShot}
              mobile={budgetMobileShot}
              alt={copy.plan.budgetAlt}
              fade
              frameClassName="max-h-[19rem] sm:max-h-[30rem]"
              className="lg:col-span-7"
            />
            {/* The day as a phone-width column: legible at this size on every screen. */}
            <ProductShot
              image={timelineMobileShot}
              alt={copy.plan.timelineAlt}
              fade
              frameClassName="max-h-[19rem] sm:max-h-[30rem]"
              className="sm:mx-auto sm:w-full sm:max-w-sm lg:col-span-4 lg:col-start-9 lg:mt-20 lg:max-w-none"
            />
          </div>
        </div>
      </section>

      {/* 6. The centerpiece: one large theme, what they can make of it, then all five. */}
      <section
        id="sitio-de-tu-boda"
        aria-labelledby="sitio-de-tu-boda-titulo"
        className="scroll-mt-20 overflow-x-clip border-t border-border bg-accent-soft"
      >
        <div className={cx(containerClass, "grid gap-10 pt-14 sm:pt-20 lg:grid-cols-12 lg:items-center lg:gap-12")}>
          {/* Candlelight entering from the left edge, the real Editorial site laid over it. */}
          <div className="relative lg:col-span-7 lg:pb-8">
            <LifestylePhoto
              image={tablescapePhoto}
              small={tablescapeSmallPhoto}
              alt={copy.sites.photoAlt}
              sizes="(min-width: 1024px) 40vw, 100vw"
              position="object-[center_45%]"
              className="mkt-reveal relative -ml-4 aspect-[16/10] rounded-r-[2.5rem] sm:-ml-6 lg:-ml-40 lg:aspect-auto lg:h-[36rem] lg:w-[calc(58%+10rem)] lg:rounded-r-[5rem] xl:-ml-64 xl:w-[calc(58%+16rem)]"
            />
            <SiteRender
              theme="editorial"
              scale="half"
              className="relative z-10 -mt-16 ml-auto aspect-[4/3] w-[88%] rounded-2xl shadow-[0_2px_4px_rgb(42_34_32/0.08),0_28px_56px_-20px_rgb(42_34_32/0.4)] lg:absolute lg:right-0 lg:bottom-0 lg:mt-0 lg:w-[72%] lg:aspect-[5/4]"
            />
          </div>
          <div className="space-y-6 lg:col-span-5">
            <p className={eyebrowClass}>{copy.sites.eyebrow}</p>
            <h2 id="sitio-de-tu-boda-titulo" className={h2Class}>
              {copy.sites.title}
            </h2>
            <p className={bodyClass}>{copy.sites.body}</p>
            <ul className="divide-accent/30 border-accent/30 divide-y border-y">
              {copy.sites.points.map((point) => (
                <li key={point} className="py-3 font-serif text-xl leading-snug">
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[88rem] px-4 pt-12 pb-14 sm:px-6 sm:pt-16 sm:pb-20">
          <ThemeShowcase label={copy.sites.showcaseLabel} staggered />
        </div>
      </section>

      {/* 7. Together: a typographic pause, the people as the visual. */}
      <section id="juntos" aria-labelledby="juntos-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, "space-y-8 py-14 text-center sm:py-20")}>
          <p className={eyebrowClass}>{copy.together.eyebrow}</p>
          <h2 id="juntos-titulo" className="font-serif text-4xl leading-tight tracking-tight sm:text-6xl">
            {copy.together.title}
          </h2>
          <ul className="flex flex-col items-center gap-2 font-serif text-2xl sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-4 sm:text-3xl">
            {copy.together.people.map((person, index) => (
              <li key={person} className="flex items-center gap-4">
                {index > 0 ? (
                  <span aria-hidden="true" className="text-accent hidden sm:inline">
                    +
                  </span>
                ) : null}
                <span className="italic">{person}</span>
              </li>
            ))}
          </ul>
          <p className={cx(bodyClass, "mx-auto")}>{copy.together.body}</p>
          <p className="text-muted text-sm">{copy.together.note}</p>
        </div>
      </section>

      {/* 8. The payoff: what all the planning is for. Mostly the photo; one line. */}
      <div className="border-t border-border">
        <figure className="mx-auto w-full max-w-[88rem] px-4 py-14 sm:px-6 sm:py-20">
          <LifestylePhoto
            image={toastPhoto}
            small={toastSmallPhoto}
            alt={copy.payoff.photoAlt}
            sizes="(min-width: 1408px) 1360px, 100vw"
            position="object-[center_30%]"
            className="mkt-reveal relative aspect-[4/3] rounded-[2rem] sm:aspect-[16/9] lg:aspect-[21/9] lg:rounded-[3rem]"
          />
          <figcaption className="bg-background relative z-10 mx-auto -mt-8 w-fit max-w-[88%] rounded-2xl px-6 py-4 text-center font-serif text-2xl leading-snug text-balance sm:-mt-12 sm:px-10 sm:py-6 sm:text-4xl">
            {copy.payoff.line}
          </figcaption>
        </figure>
      </div>

      {/* 9. Questions. */}
      <section id="preguntas" aria-labelledby="preguntas-titulo" className="scroll-mt-20 border-t border-border">
        <div className={cx(containerClass, "grid gap-8 py-14 sm:py-20 lg:grid-cols-12 lg:gap-10")}>
          <h2 id="preguntas-titulo" className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl lg:col-span-4">
            {copy.faq.title}
          </h2>
          <div className="lg:col-span-8">
            <FaqList items={copy.faq.items} />
          </div>
        </div>
      </section>

      {/* 10. The last word: ask for access, flowers at sunset entering from the right. */}
      <CtaBand
        id="empezar"
        title={copy.closing.title}
        body={copy.closing.body}
        note={copy.closing.note}
        photo={
          <LifestylePhoto
            image={floralPhoto}
            small={floralSmallPhoto}
            alt=""
            sizes="(min-width: 1024px) 46vw, 100vw"
            position="object-[30%_center]"
            drift
            className="relative h-full w-full"
          />
        }
      >
        <a href={MARKETING_LINKS.ACCESS} className={primaryButtonClass}>
          {marketing.cta.access}
        </a>
        <a href={MARKETING_LINKS.PLANNERS} className={secondaryButtonClass}>
          {copy.closing.planners}
        </a>
      </CtaBand>
    </>
  );
}

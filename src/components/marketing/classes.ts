/** Shared class names of the marketing pages (Marketing Landing V1). */

/** Joins the class parts that are set. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The page column: about 6xl wide, with the phone gutter. */
export const containerClass = "mx-auto w-full max-w-6xl px-4 sm:px-6";

/** Vertical rhythm between the page's sections. */
export const sectionSpacingClass = "py-16 sm:py-24";

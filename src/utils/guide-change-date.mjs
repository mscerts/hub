// The date logic of the study guide change banner. Pure and dependency-free: the build uses it to decide
// what a page shows, and the banner's script uses it again in the visitor's browser, so "in 6 days"
// stays exact even when the page was built a day or more ago.

/** How long after a change takes effect the exam page keeps its banner (and the change page opens on "Changes"). */
export const GUIDE_CHANGE_RECENT_DAYS = 30;

const DAY_MS = 86400000;

/** Whole UTC days from `now` to the day `effective` ("YYYY-MM-DD"); negative once it has passed. */
export function daysUntil(effective, now = new Date()) {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.round((Date.parse(`${effective}T00:00:00Z`) - today) / DAY_MS);
}

/**
 * `upcoming` while the effective date is ahead, `recent` from the effective day on (day 0) for
 * `windowDays` days, otherwise null (nothing to show).
 */
export function guideChangeWhen(
  effective,
  now = new Date(),
  windowDays = GUIDE_CHANGE_RECENT_DAYS,
) {
  const days = daysUntil(effective, now);
  if (days > 0) return { kind: "upcoming", days };
  if (-days < windowDays)
    return { kind: "recent", daysAgo: days === 0 ? 0 : -days }; // never -0
  return null;
}

const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * The sentence the banner opens with, for a date label such as "November 16, 2026". `basis` says what the
 * date is: "effective" (the date the guide itself states) or "seen" (the day we saw the change, used when
 * Microsoft states no date).
 */
export function guideChangeSentence(when, dateLabel, basis = "effective") {
  if (when.kind === "upcoming")
    return `The skills measured change on ${dateLabel} (in ${plural(when.days)}).`;
  if (basis === "seen") {
    if (when.daysAgo === 0)
      return `We saw the skills measured change today, ${dateLabel}.`;
    return `We saw the skills measured change on ${dateLabel} (${plural(when.daysAgo)} ago).`;
  }
  if (when.daysAgo === 0)
    return `The skills measured changed today, ${dateLabel}.`;
  return `The skills measured changed on ${dateLabel} (${plural(when.daysAgo)} ago).`;
}

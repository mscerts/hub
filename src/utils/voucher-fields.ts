import { z } from "astro/zod";

// Frontmatter fields of a voucher page that tell the daily voucher review
// (scripts/voucher-review-check.mjs) when to look at the page again. They are
// all optional and validated here; nothing on the site renders them, except
// voucherStarts, which marks an offer UPCOMING (src/utils/voucher-upcoming.mjs).

const DATE_HINT =
  "Use a plain calendar date written as YYYY-MM-DD, for example 2026-10-31.";
const EXAM_CODE_HINT =
  "Use the exam code in capitals, for example AB-650 or GH-700.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date at 00:00:00.000 UTC, which is what YAML makes of an unquoted YYYY-MM-DD. */
function isUtcMidnight(date: Date): boolean {
  return date.getTime() % 86_400_000 === 0;
}

/** True for a real calendar day, not for one that Date would roll over (2026-02-31). */
function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/**
 * Astro parses frontmatter with js-yaml, which turns an unquoted 2026-10-31
 * into a Date (UTC midnight) and a quoted "2026-10-31" into a string. Both are
 * accepted and come out as a Date, so a page works whichever way it is written.
 * An unquoted midnight timestamp (2026-10-31T00:00:00Z, 2026-10-31 00:00:00) is
 * the very same Date and is accepted too: the voucher review reads it as its
 * day. A quoted timestamp or any other time of day is rejected: these fields
 * are calendar days.
 */
export const voucherDate = z.union(
  [
    z.date().refine(isUtcMidnight, DATE_HINT),
    z
      .string()
      .refine(isRealIsoDate, DATE_HINT)
      .transform((value) => new Date(`${value}T00:00:00.000Z`)),
  ],
  { error: DATE_HINT },
);

export const examCode = z.string().regex(/^[A-Z]{2}-\d{3}$/, EXAM_CODE_HINT);

export const voucherReviewFields = {
  /** Last day the offer can be used or claimed, as stated by the official source. */
  voucherEnds: voucherDate.optional(),
  /** Day to re-check a temporary offer that has no stated end date against its source; a stable offer carries no date. */
  reviewBy: voucherDate.optional(),
  /** The exam this offer is tied to, for a voucher about a beta or upcoming exam. */
  linkedExam: examCode.optional(),
};

/** Fields the site itself reads, unlike the review fields above. */
export const voucherDisplayFields = {
  /**
   * First day of an offer that has not started yet. Until that day (UTC) the
   * site tags the offer UPCOMING (sidebar, landing list, voucher index); the
   * review monitor does not read it.
   */
  voucherStarts: voucherDate.optional(),
};

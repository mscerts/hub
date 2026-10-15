export const examStatuses = {
  azure: {
    "AI-300": { text: "NEW", variant: "success", since: "2026-09-24" },
    "AI-500": { text: "NEW", variant: "success", since: "2026-09-30" },
    "AZ-400": { text: "RETIRING", variant: "danger" },
    "AZ-401": { text: "BETA", variant: "tip" },
    "AZ-800": { text: "RETIRED", variant: "note" },
    "AZ-801": { text: "RETIRED", variant: "note" },
    "AZ-802": { text: "NEW", variant: "success", since: "2026-09-24" },
    "DP-800": { text: "NEW", variant: "success", since: "2026-09-24" },
  },
  github: {
    "GH-600": { text: "NEW", variant: "success", since: "2026-09-24" },
    "GH-700": { text: "BETA", variant: "tip" },
  },
  aibusiness: {
    "AB-620": { text: "NEW", variant: "success", since: "2026-09-24" },
    "AB-650": { text: "BETA", variant: "tip" },
  },
  microsoft365: {
    "MS-102": { text: "RETIRING", variant: "danger" },
  },
  security: {
    "SC-500": { text: "NEW", variant: "success", since: "2026-09-24" },
  },
  power: {},
  dynamics: {},
};

// Statuses describe the current exam lifecycle state. Add an exam here when
// Microsoft confirms that it has moved from beta to general availability.
// RETIRING becomes RETIRED once the retirement date in retiring-exams.json has
// passed (the same cut-off as the RetirementBanner: the date is before today,
// UTC); the tracker entry stays as history.
//
// NEW replaces BETA for the first NEW_BADGE_DAYS days of a generally available
// exam. It carries `since`, the day the hub recorded the exam as GA (the day
// the beta monitor flagged it, or the day BETA was removed; this is not
// necessarily Microsoft's launch day), and it expires by itself: the site
// shows it through `visibleExamStatuses`, which leaves it out from the 90th
// day on, at the next build. The entry can stay in this file afterwards or be
// deleted; nothing needs to remove it.
export const NEW_BADGE_DAYS = 90;

const DAY_MS = 86_400_000;

/** The UTC midnight of a YYYY-MM-DD string that is a real day, else null. */
function utcDay(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== iso
    ? null
    : time;
}

/** Today as a UTC day, from a Date or a YYYY-MM-DD string (a bad string is an error, not "never"). */
function todayDay(today) {
  const day =
    today instanceof Date
      ? Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate(),
        )
      : utcDay(today);
  if (day === null) throw new Error(`Not a date: ${String(today)}`);
  return day;
}

/**
 * Whether a status is shown today. Every status is, except NEW: it needs a real
 * `since` day and is shown while fewer than NEW_BADGE_DAYS days have passed
 * since it (the day itself is day 0). A NEW without a valid `since`, or dated
 * in the future, is not shown.
 */
export function isExamStatusVisible(status, today = new Date()) {
  if (status?.text !== "NEW") return true;
  const since = utcDay(status.since);
  if (since === null) return false;
  const age = Math.round((todayDay(today) - since) / DAY_MS);
  return age >= 0 && age < NEW_BADGE_DAYS;
}

/**
 * examStatuses as the site shows them: expired and invalid NEW entries left
 * out, and `since` dropped, so a badge is just { text, variant }.
 */
export function visibleExamStatuses(today = new Date()) {
  return Object.fromEntries(
    Object.entries(examStatuses).map(([area, exams]) => [
      area,
      Object.fromEntries(
        Object.entries(exams)
          .filter(([, status]) => isExamStatusVisible(status, today))
          .map(([code, { text, variant }]) => [code, { text, variant }]),
      ),
    ]),
  );
}

/**
 * How long a retired exam stays in the landing page's "Recent status changes"
 * list: counted from its retirement date (day 0, when the exam is still
 * RETIRING), so the last day listed is the date + 89. The RETIRED badge itself
 * stays in the sidebar and on the page for good.
 */
export const RETIRED_LISTED_DAYS = 90;

/**
 * visibleExamStatuses as the landing page's "Recent status changes" list shows
 * them: a RETIRED exam is only listed for RETIRED_LISTED_DAYS days after its
 * retirement date. `retirementDates` maps an exam code to the retirementDate
 * (YYYY-MM-DD) of its retiring-exams.json entry; a RETIRED exam without a real
 * date there, or whose date is still ahead, is left out of the list (the
 * Retiring Exam Monitor reports a RETIRED badge without a tracker entry).
 */
export function recentExamStatuses(retirementDates, today = new Date()) {
  const now = todayDay(today);
  return Object.fromEntries(
    Object.entries(visibleExamStatuses(today)).map(([area, exams]) => [
      area,
      Object.fromEntries(
        Object.entries(exams).filter(([code, status]) => {
          if (status.text !== "RETIRED") return true;
          const retired = utcDay(retirementDates?.[code]);
          if (retired === null) return false;
          const age = Math.round((now - retired) / DAY_MS);
          return age >= 0 && age < RETIRED_LISTED_DAYS;
        }),
      ),
    ]),
  );
}

export const examStatusNames = {
  NEW: "New",
  BETA: "Beta",
  GA: "Generally Available",
  AT_RISK: "At risk",
  RETIRING: "Retiring",
  RETIRED: "Retired",
  UPCOMING: "Upcoming",
};

export const examStatusStyles = {
  NEW: "bg-green-100 text-green-800 dark:bg-green-400/15 dark:text-green-300",
  BETA: "bg-[#a855f7]/15 text-[#d8b4fe]",
  GA: "bg-green-100 text-green-800 dark:bg-green-400/15 dark:text-green-300",
  AT_RISK: "bg-amber-400/15 text-amber-300",
  RETIRING: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
  RETIRED: "bg-gray-100 text-gray-700 dark:bg-[#64748b]/15 dark:text-[#cbd5e1]",
  UPCOMING: "bg-blue-100 text-blue-800 dark:bg-blue-400/15 dark:text-blue-300",
};

export const voucherBadgeStyles = {
  "100%":
    "bg-purple-100 text-purple-800 dark:bg-purple-400/15 dark:text-purple-300",
  "50%":
    "bg-orange-100 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300",
  Special: "bg-blue-100 text-blue-800 dark:bg-blue-400/15 dark:text-blue-300",
};

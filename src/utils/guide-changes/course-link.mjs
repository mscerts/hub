// The link from an exam page's study guide banner to the course page of the exam while a change is upcoming
// (docs/course-next.md). Pure: guide-change.mjs loads the upcoming courses at build time and passes one here.

/** Whether an upcoming course has nothing left to build or confirm. */
export function upcomingCourseComplete(next) {
  const pending = next?.pending;
  return (
    !pending ||
    ["added", "confirm", "foundations"].every(
      (key) => (pending[key] ?? []).length === 0,
    )
  );
}

/**
 * The address of the upcoming tab of the exam's course page, or undefined: only while the banner says the change
 * is upcoming (from the effective day the page is the new course alone) and only for a complete upcoming course
 * (the page has the tab then; the tab link `#upcoming` opens it).
 */
export function upcomingCourseHref(code, state, next) {
  if (state?.kind !== "upcoming" || !next || !upcomingCourseComplete(next))
    return undefined;
  return `/certs/courses/${code.toLowerCase()}/#upcoming`;
}

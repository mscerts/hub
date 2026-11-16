import { studyGuideHistory } from "./guide-changes/load.mjs";
import { versionState } from "./guide-changes/state.mjs";
import { GUIDE_CHANGE_RECENT_DAYS } from "./guide-change-date.mjs";
import { changePath, examCodeOfEntry } from "./guide-changes/codes.mjs";
import { upcomingCourseHref } from "./guide-changes/course-link.mjs";

// The upcoming courses (src/data_files/courses/<CODE>.next.json), loaded for the build like the histories.
const upcomingCourses = import.meta.glob(
  "/src/data_files/courses/*.next.json",
  {
    eager: true,
    import: "default",
  },
);
const upcomingCourse = (code) =>
  Object.values(upcomingCourses).find((course) => course?.code === code);

export { GUIDE_CHANGE_RECENT_DAYS, changePath, examCodeOfEntry };

/**
 * What an exam page needs: the link to the change page and, while a change is upcoming or recent, the
 * banner (and, while the change is upcoming and its upcoming course is complete, the link to that course's tab).
 * null when the exam has no history. The banner's text is built when the site is built; its
 * script recomputes the day count in the visitor's browser (docs/study-guide-changes.md).
 */
export function guideChangeFor(code, now = new Date()) {
  const history = studyGuideHistory(code);
  if (!history) return null;
  const state = versionState(history, now).banner;
  return {
    href: changePath(code),
    state,
    courseHref: upcomingCourseHref(code, state, upcomingCourse(code)),
  };
}

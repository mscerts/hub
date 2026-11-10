import { studyGuideHistory } from "./guide-changes/load.mjs";
import { versionState } from "./guide-changes/state.mjs";
import { GUIDE_CHANGE_RECENT_DAYS } from "./guide-change-date.mjs";
import { changePath, examCodeOfEntry } from "./guide-changes/codes.mjs";

export { GUIDE_CHANGE_RECENT_DAYS, changePath, examCodeOfEntry };

/**
 * What an exam page needs: the link to the change page and, while a change is upcoming or recent, the
 * banner. null when the exam has no history. The banner's text is built when the site is built; its
 * script recomputes the day count in the visitor's browser (docs/study-guide-changes.md).
 */
export function guideChangeFor(code, now = new Date()) {
  const history = studyGuideHistory(code);
  if (!history) return null;
  return { href: changePath(code), state: versionState(history, now).banner };
}

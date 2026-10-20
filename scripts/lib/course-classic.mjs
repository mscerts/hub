/**
 * Classic material is not learned: Azure's classic deployment model, classic file shares, classic alerts and the
 * like are the old way of doing something, and a course does not teach it (maintainer, 2026-10-20: "azure classic
 * is not a thing that needs to be learnt"). A page is classic when its title has the word "classic", or an
 * address segment does (`create-classic-file-share`, `/classic/`). Pure: no I/O.
 *
 * The rule is the generator's hard filter (course-candidates.mjs, so a classic page is never judged), the
 * builder's (a classic page that was accepted before the rule is dropped and listed in the routing) and the
 * validator's (a course file cannot hold one).
 *
 * It is a word rule, not a product rule: outside Azure the word has other meanings (classic Outlook, the classic
 * SharePoint experience), and an exam about those would lose its pages too. When that matters, narrow the rule
 * here, in one place.
 */

const TITLE = /\bclassic\b/i;
const SEGMENT = /(^|[-_])classic([-_]|$)/;

/** Whether a page is classic material: `{ title, path }` of a module, unit or documentation page. */
export function isClassic({ title, path } = {}) {
  if (TITLE.test(String(title ?? ""))) return true;
  return String(path ?? "")
    .split("/")
    .some((segment) => SEGMENT.test(segment));
}

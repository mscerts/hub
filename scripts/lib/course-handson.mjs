/**
 * Which pages are hands-on material. The lab pages (src/content/docs/labs/<area>/<code>.mdx) collect it, so a
 * course page does not: an exercise, a simulation, a guided or challenge project, a tutorial or quickstart, an
 * Applied Skill. Pure: no I/O. The rules of exercises, simulations and projects are the ones of AGENTS.md ("Hands-on
 * unit/module syntax"); the tutorial and quickstart rule is the maintainer's (2026-10-20: a tutorial belongs on
 * the lab page like an exercise does).
 *
 * `handsOnReason({ kind, path, title, moduleTitle })` returns null for a page the course keeps, or a short name
 * of why it is hands-on: "exercise", "simulation", "lab", "guided project", "challenge project", "tutorial",
 * "quickstart" or "applied skill".
 */

const SEPARATOR = String.raw`\s*[-–—:]`;
const PROJECT_TITLE = new RegExp(
  String.raw`^(guided|challenge)\s+project\b`,
  "i",
);
const PROJECT_SLUG = /^(guided|challenge)-project-/;
const LAB_OR_SIMULATION = new RegExp(
  String.raw`^(lab|simulation)${SEPARATOR}`,
  "i",
);
const TUTORIAL_OR_QUICKSTART = /\b(tutorial|quickstart)s?\b/i;
const TUTORIAL_SEGMENT =
  /(^|-)(tutorials?|quickstarts?|quick-create|quick-start)(-|$)/;
const APPLIED_SKILLS = /^\/credentials\/applied-skills\//;

const slugOf = (path) => path.split("/").filter(Boolean);

/** The project a module title or slug names ("guided project" or "challenge project"), or null. */
function projectOf(title, slug) {
  const named = PROJECT_TITLE.exec(title ?? "")?.[1];
  if (named) return `${named.toLowerCase()} project`;
  const sluggy = PROJECT_SLUG.exec(slug ?? "")?.[1];
  return sluggy ? `${sluggy} project` : null;
}

export function handsOnReason({ kind, path, title, moduleTitle } = {}) {
  const text = String(title ?? "");
  const parts = slugOf(String(path ?? ""));
  if (APPLIED_SKILLS.test(String(path ?? ""))) return "applied skill";
  if (kind === "module") {
    const project = projectOf(text, parts[2]);
    if (project) return project;
  }
  if (kind === "unit") {
    // a unit of a guided or challenge project is hands-on whatever its own title says
    const project = projectOf(moduleTitle, parts[2]);
    if (project) return project;
  }
  if (/\bexercise\b/i.test(text)) return "exercise";
  if (LAB_OR_SIMULATION.test(text)) {
    return /^simulation/i.test(text) ? "simulation" : "lab";
  }
  if (kind === "docs") {
    const word = TUTORIAL_OR_QUICKSTART.exec(text)?.[1];
    if (word) return word.toLowerCase();
    // a quickstart or tutorial whose title lost its prefix still has it in its address
    const segment = parts.find((s) => TUTORIAL_SEGMENT.test(s));
    if (segment)
      return /quick/.test(segment.match(TUTORIAL_SEGMENT)[2])
        ? "quickstart"
        : "tutorial";
  }
  return null;
}

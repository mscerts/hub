/**
 * The hub's exam areas: the folders under src/content/docs that hold exam pages
 * and the exam code prefixes that belong to each. Imports nothing.
 */

// The area folders that hold exam pages (<area>/<CODE>.mdx).
export const EXAM_AREAS = Object.freeze([
  "aibusiness",
  "azure",
  "dynamics",
  "github",
  "microsoft365",
  "power",
  "security",
]);

// Exam code prefix -> hub area directory. The single source: scripts/new-exam.mjs
// and the New Exam Monitor import it. Keep the area mapping in AGENTS.md
// ("Exam Pages") in step with it.
export const AREA_BY_PREFIX = Object.freeze({
  AZ: "azure",
  AI: "azure",
  DP: "azure",
  AB: "aibusiness",
  MB: "dynamics",
  GH: "github",
  MS: "microsoft365",
  MD: "microsoft365",
  PL: "power",
  SC: "security",
});

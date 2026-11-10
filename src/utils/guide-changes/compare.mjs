// Pairs of exams whose study guides the change pages compare: the exams being replaced and their
// replacement. The Compared to tab appears on the replacement's page and on the page of each replaced exam
// that still has one. The retirement dates in the tab's note come from src/data_files/retiring-exams.json
// (docs/study-guide-changes.md).
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";
import { areasByTarget } from "./compare-areas.mjs";
import { groupAreasByTarget } from "./compare-groups.mjs";
import { moveEdge } from "./diff.mjs";

/**
 * - `from`: the exam codes being replaced (several when one exam replaces two: their guides are merged);
 * - `to`: the replacement;
 * - `retired`: the retirement date of each replaced exam that retiring-exams.json does not list (Microsoft
 *   Learn, "Recently retired exams", https://learn.microsoft.com/credentials/support/retired-certification-exams);
 * - `titleThreshold`: how alike two group titles (and domain titles, when the pair has no hand-made areas)
 *   must be to count as the same (default 0.5);
 * - `blurb`: replaces the note's first sentence when "X is the replacement for Y" is not the whole story.
 * Only replacements Microsoft names count: the Skills Hub posts that announce the retirements (the AI and
 * Azure post of May 28, 2026: DP-100, AI-900, AI-102, AZ-204, AZ-500, AZ-800 and AZ-801; the Dynamics and
 * Power Platform post: MB-280 to AB-210, PL-200 to AB-410) and the retiring-exams tracker. Retired exams with
 * no replacement (PL-600, MB-700, MB-335, MB-240, PL-500, the fundamentals) are left out. The guides of the
 * exams that retired are read once from Learn by scripts/study-guide-history-retired.mjs.
 */
export const comparisonPairs = [
  { from: ["AZ-400"], to: "AZ-401" },
  { from: ["AZ-800", "AZ-801"], to: "AZ-802", titleThreshold: 0.35 },
  { from: ["MB-330"], to: "AB-330" },
  { from: ["MS-102"], to: "AB-650" },
  {
    from: ["PL-400"],
    to: "AB-400",
    blurb:
      "<strong>AB-400 is the new name of PL-400</strong>, the same certification.",
  },
  { from: ["AI-102"], to: "AI-103", retired: { "AI-102": "2026-06-30" } },
  { from: ["AI-900"], to: "AI-901", retired: { "AI-900": "2026-06-30" } },
  { from: ["DP-100"], to: "AI-300", retired: { "DP-100": "2026-06-01" } },
  { from: ["AZ-204"], to: "AI-200", retired: { "AZ-204": "2026-07-31" } },
  { from: ["AZ-500"], to: "SC-500", retired: { "AZ-500": "2026-08-31" } },
  { from: ["MB-280"], to: "AB-210", retired: { "MB-280": "2026-07-31" } },
  { from: ["PL-200"], to: "AB-410", retired: { "PL-200": "2026-08-31" } },
];

/** The pair an exam belongs to (as a replaced exam or as the replacement), or undefined. */
export const comparisonFor = (code) =>
  comparisonPairs.find((pair) => pair.to === code || pair.from.includes(code));

/**
 * What buildChangePage needs to compare the guide of `code` with its partner(s): `{ from, to, retirements,
 * blurb, titleThreshold }`, or null when the exam is in no pair or one of the guides has not been recorded.
 * `historyOf(code)` gives a recorded history; `retiringExams` is the `exams` list of retiring-exams.json.
 */
export function comparisonInput(code, historyOf, retiringExams = []) {
  const pair = comparisonFor(code);
  if (!pair) return null;
  const from = pair.from.map((c) => ({ code: c, history: historyOf(c) }));
  const to = { code: pair.to, history: historyOf(pair.to) };
  if (!to.history || from.some((f) => !f.history)) return null;
  return {
    from,
    to,
    retirements: pair.from.flatMap((c) => {
      const date =
        retiringExams.find((e) => e.code === c)?.retirementDate ??
        pair.retired?.[c];
      return date ? [{ code: c, date }] : [];
    }),
    blurb: pair.blurb,
    titleThreshold: pair.titleThreshold,
    areas: areasByTarget[pair.to] ?? null,
    groups: groupAreasByTarget[pair.to] ?? null,
  };
}

/**
 * What the diff needs from the hand-made group pairing of a pair (`groupAreasByTarget`): `edges` (every old
 * group an entry names with every new one it names: the only places a skill of an old group listed here may
 * count as moved), `grouped` (the old groups an entry lists) and `covered` (old group to the new group that
 * covers it at a higher level, for the entries marked `broader`).
 */
export function groupGraph(groups) {
  const edges = new Set();
  const grouped = new Set();
  const covered = new Map();
  for (const entry of groups ?? [])
    for (const old of entry.from) {
      grouped.add(old);
      for (const now of entry.to) edges.add(moveEdge(old, now));
      if (entry.broader && entry.to.length) covered.set(old, entry.to[0]);
    }
  return { edges, grouped, covered };
}

/**
 * What the diff needs from the hand-made areas of a pair (compare-areas.mjs): `pairs` (old domain title to
 * new, for the entries that are one to one) and `edges` (every old domain an entry names with every new one it
 * names: the only places a skill may count as moved).
 */
export function areaGraph(areas) {
  const pairs = new Map();
  const edges = new Set();
  for (const area of areas ?? []) {
    // A minor entry says where part of a domain went, and `pair: false` says the domains are not the same
    // domain although one went to the other: neither pairs the domains.
    if (
      !area.minor &&
      area.pair !== false &&
      area.from.length === 1 &&
      area.to.length === 1
    )
      pairs.set(area.from[0], area.to[0]);
    for (const old of area.from)
      for (const now of area.to) edges.add(moveEdge(old, now));
  }
  return { pairs, edges };
}

/**
 * One guide made of several: the audience profiles, the skills-at-a-glance lists and the domains of each,
 * one after the other (AZ-800 and AZ-801 become one old guide to compare with AZ-802). Returns
 * `{ lines, sources }`; `sources` maps each domain title to the code of the guide it came from. A guide that
 * cannot be split is left out of `lines`.
 */
export function mergeGuides(guides) {
  const AUDIENCE = "### Audience profile";
  const GLANCE = "### Skills at a glance";
  const parts = [];
  const sources = new Map();
  for (const { code, lines } of guides) {
    const glance = lines.indexOf(GLANCE);
    const audience = lines.indexOf(AUDIENCE);
    if (glance < 0 || audience < 0 || audience > glance) continue;
    let bodyStart = lines.findIndex(
      (line, i) => i > glance && line.startsWith("### "),
    );
    if (bodyStart < 0) bodyStart = lines.length;
    parts.push({
      audience: lines.slice(audience + 1, glance),
      glance: lines.slice(glance + 1, bodyStart),
      body: lines.slice(bodyStart),
    });
    for (const domain of parseGuide(lines).domains)
      sources.set(domain.title, code);
  }
  const heading = guides[0].lines[0].replace(/ as of .*$/, "");
  return {
    lines: [
      heading,
      AUDIENCE,
      ...parts.flatMap((p) => p.audience),
      GLANCE,
      ...parts.flatMap((p) => p.glance),
      ...parts.flatMap((p) => p.body),
    ],
    sources,
  };
}

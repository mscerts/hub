// A small, synthetic course file for the tests: the real GH-900 study guide's tree with a few made-up picks.
// It is an example of the format only: nothing here is a statement about what GH-900 learners should read.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";

const fixtures = resolve(import.meta.dirname, "../../fixtures/course-source");

export const readGuideFixture = (code) =>
  JSON.parse(readFileSync(join(fixtures, `guide-${code}.json`), "utf8"));

export const FINGERPRINT = "0123456789abcdef0123456789abcdef01234567";

export const pick = (extra = {}) => ({
  target: { kind: "module", path: "/training/modules/intro-to-github" },
  title: "Introduction to GitHub",
  class: "core",
  source: "P1",
  decision: { by: "auto", at: "2026-10-17" },
  ...extra,
});

/** The parsed GH-900 guide and a valid course file built on its tree. */
export function exampleCourse() {
  const fixture = readGuideFixture("GH-900");
  const guide = { ...parseGuide(fixture.lines), hash: fixture.hash };
  const domains = guide.domains.map((d) => ({
    title: d.title,
    weight: d.weight,
    groups: d.groups.map((g) => ({
      title: g.title,
      tasks: g.tasks.map((t) => ({ key: t.key, text: t.text, picks: [] })),
    })),
  }));
  const tasks = domains.flatMap((d) => d.groups.flatMap((g) => g.tasks));
  tasks[0].picks = [pick()];
  tasks[1].picks = [
    pick({
      target: { kind: "docs", path: "/azure/github/overview" },
      title: "What is GitHub?",
      source: "P2",
    }),
  ];
  tasks[2].picks = [
    pick({
      target: {
        kind: "unit",
        path: "/training/modules/intro-to-github/2-what-is-git",
      },
      title: "What is Git?",
    }),
    pick({
      target: { kind: "docs", path: "/azure/github/branches" },
      title: "About branches",
      class: "supporting",
      relation: "prerequisite",
      why: "You create and switch branches before you can open a pull request.",
      evidence:
        "About branches: branches let you develop features in isolation.",
      source: "P2",
    }),
  ];
  tasks[3].picks = [
    pick({
      target: {
        kind: "module",
        path: "/training/modules/advanced-git-workflows",
      },
      title: "Advanced Git workflows",
      class: "supporting",
      relation: "deeper",
      why: "The same feature in more depth.",
      evidence: "Advanced Git workflows: rebase, cherry-pick and bisect.",
      source: "P3",
      decision: { by: "maintainer", at: "2026-10-17" },
    }),
  ];
  const course = {
    schemaVersion: 1,
    code: "GH-900",
    name: guide.name ?? fixture.name,
    inputs: {
      guideHash: fixture.hash,
      guideAsOf: guide.asOf?.text,
      scopeFingerprint: FINGERPRINT,
      builtAt: "2026-10-17",
    },
    domains,
    rejected: [
      {
        taskKey: tasks[0].key,
        path: "/training/modules/entitlement-management",
        reason: "different role: identity governance",
        at: "2026-10-17",
      },
    ],
  };
  return { course, guide, fixture };
}

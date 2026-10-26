// A small, synthetic course file for the tests: the real GH-900 study guide's tree with a few made-up picks.
// It is an example of the format only: nothing here is a statement about what GH-900 learners should read.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";
import {
  buildScopeMap,
  fingerprintOfSnapshot,
} from "../../../scripts/lib/course-scope.mjs";

const fixtures = resolve(import.meta.dirname, "../../fixtures/course-source");

export const readGuideFixture = (code) =>
  JSON.parse(readFileSync(join(fixtures, `guide-${code}.json`), "utf8"));

// What Learn "offers" in the tests: GH-900's official course (one learning path with one module that lists two
// documentation pages) and a module of another exam. A fresh object every call, so a test can change it.
export function learnInputs() {
  return {
    courses: [
      {
        course_number: "GH-900T00",
        title: "GitHub Foundations",
        url: "https://learn.microsoft.com/en-us/training/courses/gh-900t00/",
        last_modified: "2026-01-01T00:00:00Z",
        study_guide: [{ uid: "learn.path-github", type: "learningPath" }],
      },
    ],
    learningPaths: [
      {
        uid: "learn.path-github",
        title: "GitHub Foundations path",
        path: "/training/paths/github-foundations",
        modules: ["/training/modules/intro-to-github"],
      },
    ],
    modules: [
      {
        uid: "learn.intro-to-github",
        path: "/training/modules/intro-to-github",
        title: "Introduction to GitHub",
        unitSig: "sig-intro",
        units: ["Introduction", "What is Git?", "Summary"],
        unitUrls: [
          "/training/modules/intro-to-github/1-introduction",
          "/training/modules/intro-to-github/2-what-is-git",
          "/training/modules/intro-to-github/3-summary",
        ],
      },
      {
        uid: "learn.git-basics",
        path: "/training/modules/git-basics",
        title: "Git basics",
        unitSig: "sig-basics",
        units: ["Introduction", "Create a repository", "Summary"],
        unitUrls: [
          "/training/modules/git-basics/1-introduction",
          "/training/modules/git-basics/2-create-a-repository",
          "/training/modules/git-basics/3-summary",
        ],
      },
      {
        uid: "learn.advanced-git-workflows",
        path: "/training/modules/advanced-git-workflows",
        title: "Advanced Git workflows",
        unitSig: "sig-advanced",
        units: ["Introduction"],
        unitUrls: ["/training/modules/advanced-git-workflows/1-introduction"],
      },
    ],
    moduleLinks: {
      lastChecked: "2026-10-17T00:00:00Z",
      modules: [
        {
          path: "/training/modules/intro-to-github",
          unitSig: "sig-intro",
          unit: "/training/modules/intro-to-github/3-summary",
          unitTitle: "Summary",
          harvestedAt: "2026-10-17",
          links: [
            {
              kind: "docs",
              path: "/azure/github/overview",
              text: "What is GitHub?",
              section: "Learn more",
            },
            {
              kind: "docs",
              path: "/azure/github/branches",
              text: "About branches",
              section: "Learn more",
            },
          ],
        },
      ],
    },
  };
}

export const scopeMapFor = (inputs = learnInputs()) =>
  buildScopeMap({ code: "GH-900", ...inputs });

// what the example course was "built from"
export const SCOPE = scopeMapFor().inputs.snapshot;
export const PICKED = [
  ["/training/modules/advanced-git-workflows", "sig-advanced"],
  ["/training/modules/git-basics", "sig-basics"],
];
export const FINGERPRINT = fingerprintOfSnapshot(SCOPE);

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
      via: "/training/modules/intro-to-github",
    }),
  ];
  // a module is placed once, as a module (docs/courses.md): the example has no unit pick
  tasks[2].picks = [
    pick({
      target: { kind: "module", path: "/training/modules/git-basics" },
      title: "Git basics",
      source: "P4",
      evidence: "Git basics: create a repository, commit and push.",
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
      via: "/training/modules/intro-to-github",
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
      scope: structuredClone(SCOPE),
      picked: structuredClone(PICKED),
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

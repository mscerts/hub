// A small, invented corner of Microsoft Learn for the course placement tests, next to four REAL study guides
// (tests/fixtures/course-source): the official courses of AZ-104 and MB-310 and four courses that are no exam's own
// (XX-1001 .. XX-4004). Nothing here says what a real course covers.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";

const root = resolve(import.meta.dirname, "../../..");

const mod = (slug, title, units = ["Introduction", "Summary"]) => ({
  uid: `learn.${slug}`,
  path: `/training/modules/${slug}`,
  title,
  products: [],
  units,
  unitUrls: units.map((_, i) => `/training/modules/${slug}/${i + 1}-unit`),
  unitSig: `sig-${slug}`,
});

const learningPath = (slug, title, modules) => ({
  uid: `learn.wwl.${slug}`,
  title,
  path: `/training/paths/${slug}`,
  modules: modules.map((m) => `/training/modules/${m}`),
});

const course = (number, title, pathSlugs) => ({
  uid: `course.${number.toLowerCase()}`,
  course_number: number,
  title,
  url: `https://learn.microsoft.com/en-us/training/courses/${number.toLowerCase()}/`,
  last_modified: "2026-01-01T00:00:00Z",
  study_guide: pathSlugs.map((slug) => ({
    uid: `learn.wwl.${slug}`,
    type: "learningPath",
  })),
});

/** Fresh objects on every call, so a test can change them. */
export function placementWorld() {
  const modules = [
    mod("manage-routes", "Configure virtual networks and user-defined routes"),
    mod(
      "manage-storage",
      "Create and configure storage accounts and Azure Files",
    ),
    mod("ledgers-currencies", "Configure ledgers and currencies"),
    mod("journals", "Implement and manage journals"),
    mod("credit-collections", "Manage credit and collections"),
    // modules of the courses that are no exam's own
    mod("virtual-network-peering", "Explore virtual network peering"),
    mod(
      "collections-activities",
      "Configure credit management processes and collections activities",
    ),
    mod("working-with-ai", "Introduction to working with AI"),
  ];
  const learningPaths = [
    learningPath("az104-net", "Administer Azure networking and storage", [
      "manage-routes",
      "manage-storage",
    ]),
    learningPath("mb310-finance", "Finance functional consultant", [
      "ledgers-currencies",
      "journals",
      "credit-collections",
    ]),
    learningPath("x1001-network", "Extend virtual networks", [
      "manage-routes",
      "virtual-network-peering",
    ]),
    learningPath("x2002-credit", "Credit and collections in practice", [
      "collections-activities",
    ]),
    learningPath("x3003-ai", "Work smarter", ["working-with-ai"]),
  ];
  const courses = [
    course("AZ-104T00-A", "Microsoft Azure Administrator", ["az104-net"]),
    course(
      "MB-310T00-A",
      "Microsoft Dynamics 365 Finance Functional Consultant",
      ["mb310-finance"],
    ),
    course("XX-1001", "Extend virtual networks with routes and peering", [
      "x1001-network",
    ]),
    course("XX-2002", "Manage credit and collections in finance", [
      "x2002-credit",
    ]),
    course("XX-3003", "Work smarter", ["x3003-ai"]),
    // its learning path is not in the catalog (yet): only the title is left to search with
    course("XX-4004", "Create users and groups in Microsoft Entra", [
      "not-in-the-catalog",
    ]),
  ];
  return { catalog: { modules, removed: [] }, learningPaths, courses };
}

/** The four real guides of the fixtures, as stored guides (the shape of learn-exams.json's studyGuides). */
export function storedGuides() {
  return ["AZ-104", "MB-310", "GH-900", "AB-100"].map((code) =>
    JSON.parse(
      readFileSync(
        join(root, "tests/fixtures/course-source", `guide-${code}.json`),
        "utf8",
      ),
    ),
  );
}

/** The guides as the placement reads them: Map code -> { name, tree }. */
export function parsedGuides() {
  return new Map(
    storedGuides().map((guide) => [
      guide.code,
      { name: guide.name, tree: parseGuide(guide.lines) },
    ]),
  );
}

/** Writes the world as a learnsync checkout (<dir>/data/learn-catalog.json and learn-content.json). */
export async function writeLearnsync(dir, world = placementWorld()) {
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(
    join(dir, "data", "learn-catalog.json"),
    JSON.stringify(world.catalog),
  );
  await writeFile(
    join(dir, "data", "learn-content.json"),
    JSON.stringify({ learningPaths: world.learningPaths }),
  );
  return dir;
}

/** Writes the stored guides as the tracker file the New Exam Monitor keeps. */
export async function writeGuidesFile(file) {
  await writeFile(file, JSON.stringify({ studyGuides: storedGuides() }));
  return file;
}

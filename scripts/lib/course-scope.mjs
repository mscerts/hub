/**
 * Exam scope map: what Microsoft itself counts as in scope for an exam.
 * exam -> official course(s) -> learning paths -> modules -> the docs links each module's last unit lists.
 * Pure: no I/O, no network. The CLI is scripts/course-source.mjs (docs/course-source.md).
 *
 * Inputs are the catalog API course list (`type=courses`, with `study_guide`: the learning-path and module
 * uids of the course), learnsync's learn-content.json (`learningPaths`), learn-catalog.json (`modules`) and
 * module-links.json (optional: modules without it simply have no resources).
 */

import { createHash } from "node:crypto";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical path of a Learn URL or path: no host, locale, query or trailing slash, lower case. */
export function learnPath(input) {
  try {
    const url = new URL(input, "https://learn.microsoft.com");
    return (
      url.pathname
        .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/|$)/i, "")
        .replace(/\/+$/, "")
        .toLowerCase() || "/"
    );
  } catch {
    return null;
  }
}

/**
 * The official courses of an exam: a course number that is the exam code followed by T (AZ-104T00,
 * AZ-104T00-A, MB-230T01) or a course whose `exam` field is `exam.<code>`. Sorted by course number.
 */
export function coursesForExam(code, courses) {
  const prefix = `${String(code).toUpperCase()}T`;
  const examUid = `exam.${String(code).toLowerCase()}`;
  return (courses ?? [])
    .filter((course) => {
      if (
        String(course.course_number ?? "")
          .toUpperCase()
          .startsWith(prefix)
      )
        return true;
      const exams = Array.isArray(course.exam) ? course.exam : [course.exam];
      return exams.some((e) => String(e ?? "").toLowerCase() === examUid);
    })
    .sort((a, b) => byText(String(a.course_number), String(b.course_number)));
}

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

/** A short hash of a module's resource links (target and `was` of each, in order); "-" when it has no record. */
export function linksHash(resources) {
  if (!resources) return "-";
  return sha1(
    JSON.stringify(
      resources.links.map((l) => [l.path ?? l.url, l.was ?? null]),
    ),
  ).slice(0, 12);
}

/**
 * What a course is built from, in a form small enough to store in the course file:
 * { courses: [[number, lastModified]], modules: [[path, unitSig, linksHash]] }, both sorted. Comparing two
 * snapshots says exactly which course or module changed; `fingerprintOfSnapshot` is their one-line summary.
 */
export function scopeSnapshot({ courses, modules }) {
  return {
    courses: courses
      .map((c) => [c.number, c.lastModified ?? ""])
      .sort((a, b) => byText(a[0], b[0])),
    modules: modules
      .map((m) => [m.path, m.unitSig ?? "", linksHash(m.resources)])
      .sort((a, b) => byText(a[0], b[0])),
  };
}

/** The 40-character fingerprint of a snapshot: it changes with the course list, a unitSig or a module's links, and with nothing else. */
export function fingerprintOfSnapshot(snapshot) {
  const lines = [
    ...snapshot.courses.map(
      ([number, lastModified]) => `course|${number}|${lastModified}`,
    ),
    ...snapshot.modules.map(
      ([path, sig, links]) => `module|${path}|${sig}|${links}`,
    ),
  ].sort(byText);
  return sha1(lines.join("\n"));
}

/**
 * Build the scope map of one exam. `learningPaths`, `modules` and `moduleLinks` are the learnsync files'
 * arrays / object. Returns
 * { code, ok, courses, paths, modules, unresolved, warnings, inputs }
 *   ok          true when an official course was found and at least one module resolved
 *   courses     [{ number, title, path, lastModified }]
 *   paths       [{ uid, title, path, modules: [path] }]   in course order
 *   modules     [{ path, uid, title, unitSig, units: [title], paths: [uid], resources: null | { unit, unitTitle, harvestedAt, links } }]
 *   unresolved  study_guide uids that are neither a known learning path nor a known module
 *   inputs      { fingerprint, resourceModules, moduleLinksChecked }
 * `fingerprint` changes when the course list, a module's unitSig or a module's resources change, and
 * only then: it is what "has anything this exam's courses are built from changed" compares.
 */
export function buildScopeMap({
  code,
  courses,
  learningPaths,
  modules,
  moduleLinks,
}) {
  const matched = coursesForExam(code, courses);
  const pathByUid = new Map((learningPaths ?? []).map((p) => [p.uid, p]));
  const moduleByUid = new Map((modules ?? []).map((m) => [m.uid, m]));
  const moduleByPath = new Map((modules ?? []).map((m) => [m.path, m]));
  const recordByPath = new Map(
    (moduleLinks?.modules ?? []).map((r) => [r.path, r]),
  );
  const warnings = [];
  const unresolved = [];
  const pathsOut = [];
  const seenPaths = new Set();
  const modulesOut = new Map();

  const addModule = (modulePath, pathUid) => {
    const known = modulesOut.get(modulePath);
    if (known) {
      if (pathUid && !known.paths.includes(pathUid)) known.paths.push(pathUid);
      return;
    }
    const record = moduleByPath.get(modulePath);
    if (!record) {
      warnings.push(
        `module ${modulePath} is not in the catalog (out of scope or removed): left out`,
      );
      return;
    }
    const links = recordByPath.get(modulePath);
    modulesOut.set(modulePath, {
      path: modulePath,
      uid: record.uid ?? null,
      title: record.title ?? null,
      unitSig: record.unitSig ?? null,
      units: Array.isArray(record.units) ? record.units : [],
      paths: pathUid ? [pathUid] : [],
      resources: links
        ? {
            unit: links.unit,
            unitTitle: links.unitTitle ?? null,
            harvestedAt: links.harvestedAt ?? null,
            links: links.links,
          }
        : null,
    });
  };

  for (const course of matched) {
    for (const entry of course.study_guide ?? []) {
      const learningPath = pathByUid.get(entry.uid);
      if (learningPath) {
        if (!seenPaths.has(learningPath.uid)) {
          seenPaths.add(learningPath.uid);
          pathsOut.push({
            uid: learningPath.uid,
            title: learningPath.title ?? null,
            path: learningPath.path ?? null,
            modules: [...(learningPath.modules ?? [])],
          });
        }
        for (const modulePath of learningPath.modules ?? [])
          addModule(modulePath, learningPath.uid);
      } else if (moduleByUid.has(entry.uid)) {
        addModule(moduleByUid.get(entry.uid).path, null);
      } else {
        unresolved.push(entry.uid);
      }
    }
  }
  if (matched.length === 0)
    warnings.push(`no official course found for ${code}`);
  if (unresolved.length > 0)
    warnings.push(
      `${unresolved.length} course entries resolve to no learning path or module: ${unresolved.join(", ")}`,
    );

  const moduleList = [...modulesOut.values()];
  const courseOut = matched.map((c) => ({
    number: c.course_number,
    title: c.title ?? null,
    path: learnPath(c.url ?? ""),
    lastModified: c.last_modified ?? null,
  }));
  const snapshot = scopeSnapshot({ courses: courseOut, modules: moduleList });
  return {
    code,
    ok: matched.length > 0 && moduleList.length > 0,
    courses: courseOut,
    paths: pathsOut,
    modules: moduleList,
    unresolved,
    warnings,
    inputs: {
      fingerprint: fingerprintOfSnapshot(snapshot),
      snapshot,
      resourceModules: moduleList.filter(
        (m) => m.resources && m.resources.links.length > 0,
      ).length,
      moduleLinksChecked: moduleLinks?.lastChecked ?? null,
    },
  };
}

# Study guide parser and exam scope map

*Runbook of `scripts/course-source.mjs`. Repo-wide rules live in [AGENTS.md](../AGENTS.md).*

A command-line tool, not a monitor: it runs by hand, writes nothing to the repository and is not part of the build or CI. It prepares the two inputs that a course page for an exam is built from.

- **The guide tree.** An exam's study guide as `domain (with weight) > skill group > task`, plus the "skills measured as of" date and the guide's content hash. The study guide is the source of truth for what an exam covers, so the tree is the skeleton of a course.
- **The exam scope map.** What Microsoft itself counts as in scope: exam > official course > learning paths > modules > the documentation links that the last unit of each module lists (learnsync's `module-links.json`). An exam with no official course gets an empty map.

Both are computed on demand. Nothing is committed per exam: derived files would go stale when a guide or a module changes.

## Commands

```bash
node scripts/course-source.mjs AZ-104 [--out DIR]     # guide tree + scope map -> DIR/AZ-104.guide.json, DIR/AZ-104.scope.json
node scripts/course-source.mjs --survey               # one line per stored guide: the shapes in the wild
node scripts/course-source.mjs AZ-104 --check src/content/docs/courses/az-104course.mdx   # does a course page match the guide?
```

Exit codes: 0 done, 1 the guide did not parse completely (or the course differs from it), 2 a usage or input error. The default output folder is `<tmp>/course-source`.

## Inputs

| What | Where | Notes |
|------|-------|-------|
| The guide text | `src/data_files/learn-exams.json` (`LEARN_EXAMS_FILE`) | The text the New Exam Monitor stores of the guides of the exams the hub covers, so nothing is fetched and the tree is exactly what the monitor hashed. An exam without stored text (a beta exam with no guide yet) cannot be parsed. |
| learnsync data | a checkout in `LEARNSYNC_DIR` (default `../learnsync` next to this repo), else `mscerts/learnsync` `main` on raw.githubusercontent.com | `learn-catalog.json` and `learn-content.json` are required; `module-links.json` is optional (modules then have no resources, with a warning). |
| The course list | `https://learn.microsoft.com/api/catalog/?type=courses` | One request. The cached `learn-content.json` has no course > learning path edges. |

## The guide tree

`parseGuide` (`scripts/lib/course-guide.mjs`) returns `{ ok, asOf, domains, stats, warnings }`. `ok` is false when no domain was found, a domain of the guide's "Skills at a glance" list has no section, or a domain has no task: do not use such a tree as if it were complete.

The parser anchors on the "Skills at a glance" list, which names every domain and its weight, not on heading depth. A heading whose text is one of those names starts that domain, any other heading in the skills section is a skill group, and the bullets under it are its tasks. That is what makes it work on the guides that do not follow the usual `### domain` / `#### group` shape. Checked on the 56 stored guides (3,905 tasks, median about 64 per guide): all parse. The things Microsoft's guides do that the parser absorbs, each reported as a warning:

- **Irregular heading levels** (GH-900: an h1 domain and an h2 used as a group; PL-300 mixes h3 and h4).
- **A glance bullet and its heading worded differently** (AZ-802 "Manage virtual machines" / "Manage VMs", MS-721, DP-900, AI-200): matched by equal weight and the most words in common; the glance wording is the domain title and the heading text is kept as `headingText`.
- **A glance list that names a domain twice** (GH-300): the entry with no section of its own is dropped. Two entries that both have a section stay two domains (AB-410 has "Create a foundation for intelligent applications" and "Create intelligent applications", both 25-30%).
- **Bullets directly under a domain**: collected in an implicit group named after the domain.
- **No glance list**: the headings that carry a weight are the domains.

Each task has a `key` (`domain/group/task` in slug form, unique in the guide) for later comparison. `asOf` is `{ text, iso }` (`iso` is `YYYY-MM-DD`, `YYYY-MM` for a month-only date such as GH-900's, or null). Thirteen guides state no date (beta or very new exams).

`diffTrees(guideTree, courseTree)` compares two trees by title, level by level (whitespace, quote and dash variants are ignored, case is not), so one inserted task is one difference, not a cascade: `missing-*`, `extra-*` and `reordered-*`. `treeFromCourseMdx` reads a course page written with `##` domain (weight in the title), `###` group and `####` task headings, which is what `--check` uses.

## The scope map

`buildScopeMap` (`scripts/lib/course-scope.mjs`) finds the exam's official courses (a course number that is the exam code followed by `T`, such as `AZ-104T00` or `MB-230T01`, or a course whose `exam` field is `exam.<code>`), follows each course's `study_guide` entries to learning paths (in course order) and modules, and attaches each module's units and resource links. A module shared by several paths is listed once with all of them. What it cannot resolve is reported in `unresolved` / `warnings`, never guessed.

`inputs.fingerprint` is a hash of the course list (number and last-modified), every module's `unitSig` and every module's resource links (with `was`). It changes when something the exam's courses are built from changes, and only then, so "has anything changed since this course was built" is a comparison of two hashes. Together with the guide's own `hash`, it is the pair of facts a rebuild decision needs.

## Tests

`tests/scripts/course-guide.test.mjs`, `course-scope.test.mjs` and `course-source.test.mjs`, offline. The guide fixtures in `tests/fixtures/course-source/` are real guides (AZ-104, GH-900, MB-310, AB-100) saved from the tracker; the tests never read `learn-exams.json` itself, which a monitor rewrites. To look at all current guides use `--survey`; a guide that stops parsing there is a reason to extend the parser with a fixture of the new shape, not to loosen a test.

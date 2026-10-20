# Course placement: which exam page a course belongs on

*Runbook of `scripts/course-placement.mjs` and `scripts/lib/course-placement.mjs`. Repo-wide rules live in [AGENTS.md](../AGENTS.md). It uses the same inputs and the same lexical search as the [candidate generator](course-candidates.md), described in [course-source.md](course-source.md).*

A command-line tool and a courtesy of the [Course Videos Monitor](monitors/course-videos.md). It runs by hand, writes nothing to the repository and is not part of the build.

**The problem.** Microsoft Learn has courses that are no exam's own course: the four-digit ones (`AI-3026` "Develop AI agents on Azure", `SC-5006` "Enhance security operations by using Microsoft Security Copilot", `AZ-2008` "DevOps Foundations") and a few three-digit ones whose exam has no hub page. Their recordings on YouTube are useful to some exam, but nothing in the data says which: a card for `AZ-104` goes on the `AZ-104` page, a card for `AI-3026` goes on whichever page a maintainer decides. Fifteen of the nineteen four-digit courses that had a recording on 2026-10-20 were on no page (`--unplaced` lists them, and two three-digit ones whose exam has no hub page: `AI-900`, `DP-605`).

**What it does.** It suggests exam pages, with the evidence for each, and decides nothing. A person looks at the suggestion and at the course and the study guide, and puts the card on the page (or on none).

## Commands

```bash
node scripts/course-placement.mjs AI-3026 SC-5006     # suggestions for these courses (a course number such as AI-3026-A works too)
node scripts/course-placement.mjs --unplaced          # every course with a recording that has no exam page of its own code and no card on any hub page
node scripts/course-placement.mjs --json AI-3026      # the same as JSON (code, title, modules, suggestions with reasons)
```

Exit codes: 0 done, 2 a usage or input error (an unknown course, no learnsync data, no stored guides). A course the Learn catalog does not list (`AI-3016` has a short link and a playlist but no catalog entry) is matched by the title of its playlist, which YouTube's oEmbed endpoint gives without a key; the output says so. A course with no learning paths in the catalog (yet) is matched by its title alone.

## Inputs

The same as the candidate generator, minus the documentation files: the stored study guides (`src/data_files/learn-exams.json`, `LEARN_EXAMS_FILE`), the learnsync catalog and content (a checkout in `LEARNSYNC_DIR`, else `../learnsync`, else GitHub `main`: about 7 MB) and the course list of the Learn catalog API. Only guides that parse completely are used; the command line names the others.

## How it decides

Three channels, kept apart so that every suggestion says why it is there:

| Channel | What it looks at | Strength |
|---------|------------------|----------|
| **Shared modules** | The modules of the course (its learning paths, resolved through learnsync) that an exam's **official** course contains too (`pools.official`, the same index the candidate generator uses for its `P1`/`P3` provenance). "Shares 9 of 9 modules with its official course" is a statement of fact. | Deterministic, the strongest evidence. It counts for 2 points when the exam's course holds at least 30% of the course's modules (`minSharedShare`), for 0.5 below that. |
| **Guide match** | The course's title (twice) and the titles of its modules as a query against one document per exam: name, domain titles, skill group titles and task texts of its study guide (BM25 with the pipeline's stemmer and abbreviations). The words that matched are listed, rarest first. | 1 point for the three best exams whose guide contains at least 20% of the course's words (rarity weighted). Measured on 2026-10-20 with the 52 official exam courses as the test set (the answer is their own exam): first for 47, in the first three for all 52. |
| **Skill groups covered** | Skill groups (and tasks) of an exam whose words the course's modules contain almost completely (85%, rarity weighted by the whole module index): "Implement Microsoft Security Copilot" is covered by a module about Security Copilot. | 1 point for an exam with a covered group. Weaker as a ranking (first for 35 of the 52 test courses, in the first three for 48), but it finds exams the guide match misses, and its evidence is a name a person can read. Covered tasks alone only decorate an exam that is there for another reason. |

Exams are listed by points, then by the number of shared modules, the groups covered and the guide rank. The label is `strong` (3 points or more), `likely` (2) or `possible` (1). The course's own exam (`DP-605` for `DP-605T00`) is never suggested for it, and at most six exams are listed (`maxSuggestions`). There is deliberately **no blended score**: an exam several channels agree on comes first, and the reasons show which.

Every threshold is an option of `suggestExams` (`PLACEMENT_DEFAULTS` in the lib); the tests change them.

**How good is it.** On the five placements the hub already has (checked 2026-10-20): `AI-3026` on `AI-103` is the first suggestion (strong: it shares all 9 of its modules with the `AI-103` course); `AZ-2008` is on `AZ-400` and `AZ-401`, and the suggestions are `AZ-401` first and `AZ-400` fourth; `SC-5006` is on `SC-500` by the maintainers' decision, and the suggestions are `SC-200` first (its course holds 5 of the 6 modules) and `SC-500` second (it covers the group "Implement Microsoft Security Copilot"); `MS-4023` has no card yet and shares all four modules with `AB-730`. Courses about a product with its own exam (`AB-6002` Dynamics 365 finance: `MB-310`; `SC-5001` Sentinel: `SC-200`; `MD-4011` Intune: `MD-102`) get that exam first. Courses that are about no exam in particular (`Work smarter with AI`) get `possible` suggestions or none: the output then says "no suggestion". Treat `possible` as a lead, not as an answer.

## In the Course Videos Monitor

When a short link starts to resolve and its code has no exam page of its own (`AZ-401` is its own placement; `AI-3026` is not), the monitor's issue gets a "Suggested exam pages" column with the three best suggestions and their reasons. The suggestions need the learnsync data and the stored guides; when they cannot be read (learnsync unreachable, a guide file missing) the issue is written without them, with a warning annotation, because the card matters more than where it goes. `PLACEMENT=0` switches the column off.

## Tests

`tests/scripts/course-placement.test.mjs` (the lib, the loader and the command line) and, for the issue, `tests/scripts/course-videos-check.test.mjs`, offline: four real study guides (`tests/fixtures/course-source/`) and an invented corner of Learn in `tests/scripts/helpers/example-placement.mjs` (two official courses and four courses that are no exam's own, each built to trigger one channel).

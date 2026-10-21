# Learn Course Tracker

*Runbook of the Learn Course Tracker. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the other monitors are listed in the [index](README.md).*

Weekly sync of one file, `src/data_files/learn-courses.json`, that lists **every course of the Microsoft Learn catalog** (139 on 2026-10-21: the exam courses, the four-digit courses such as AI-3026 and SC-5006, and the education courses) and **which hub exam pages each is assigned to**. It tells you about a new course, a course Learn removes while a hub page still links it, a confirmed page that lacks the course card, a retiring exam's course that is due to leave its replacement's page, and a retiring Applied Skill built on a tracked course. **Nothing is placed automatically:** the monitor proposes, the running issue shows the context, and the maintainer decides. It is the Learn-catalog side of the course work; the YouTube recordings of the courses are the [Course Videos Monitor](course-videos.md)'s, and the two share the course codes and the placement tool ([course-placement.md](../course-placement.md)).

- **Workflow:** `.github/workflows/learn-courses-monitor.yml` — Wednesday 09:40 UTC (after Monday's learnsync runs) + manual trigger with `force_baseline`. The sync step opens or updates the issue itself BEFORE the file is committed, so a failed issue step skips the commit and the next run derives the same list again; the commit retries its push three times. A run is never cancelled half way. A failing sync raises one `bug` issue titled `Learn courses: the sync failed` (a comment per further failed run, closed by the next healthy run, through `scripts/failure-issue.mjs`).
- **Script:** `scripts/learn-courses-sync.mjs` — Node, no dependencies; the rules and the file format are in `scripts/lib/learn-courses.mjs`. `node scripts/learn-courses-sync.mjs --check` is the read-only form: nothing is written and no issue is touched, the report goes to `REPORT_FILE`. Tests, fully offline (the catalog answers and the hub pages are small copies in a temp folder, learnsync's data and the placement are injected, the issue goes to an in-memory `gh`), are in `tests/scripts/learn-courses.test.mjs`.
- **Tracker:** `src/data_files/learn-courses.json` — `{ schemaVersion, lastSynced, reported, courses }`, one course per line, sorted by key. The script writes the catalog's fields; you write the decisions (below). Never edit `reported` by hand.
- **Config:** none. The decisions are in the entries.

## The two kinds of course

Decided by the maintainer on 2026-10-21.

| `kind` | Which courses | Where it goes |
|--------|---------------|---------------|
| `exam` | The number is `<CODE>T<nn>` and `<CODE>` is an exam on Learn (the exams of `learn-exams.json` and the hub's own exam pages): `AZ-104T00`, `PL-400T00`. 55 of the 61 `T`-numbered courses; not every three-digit course is a credential (DP-605T00, AZ-040T00, DP-080T00 and three more are not). | **Only its exam's page** (origin `exam`, confirmed by the rule), or **temporarily the page of the exam that replaces it** while it retires (`retiring-exams.json` `replacementCode`: AZ-400T00 on AZ-401, MS-102T00 on AB-650, MB-330T00 on AB-330; origin `replacement`, `temporary`, proposed until you confirm). A course whose exam has no hub page is `no-page`. A renamed exam is the entry's `examPage` (PL-400T00 has `"examPage": "AB-400"`: PL-400 became AB-400). An exam course is never proposed for a second exam by relevancy. |
| `other` | Everything else: the four-digit courses, the non-exam `T` courses, the education courses. | **By relevancy to the exams, many pages allowed, always confirmed by you.** |

An **archived** exam page keeps its course card as long as the course is in the catalog; when Learn removes the course the issue says so and you remove the card.

## What the relevancy is

For a course of kind `other` that has no confirmed page the sync asks the placement tool (`scripts/course-placement.mjs`, [course-placement.md](../course-placement.md)) for the hub pages it may belong on and stores up to four as `proposed`, each with the reason in plain words and a confidence (`strong`, `likely`, `possible`):

- **modules** — the course's modules that an exam's official course lists too (the strongest evidence);
- **guide** — the course's title and module titles against the study guide text of the exam;
- **groups** — skill groups of an exam whose words the course's modules contain almost completely.

A hub page that **already has a card** for the course (its Learn page `learn.microsoft.com/training/courses/<key>`, `aka.ms/<CODE>onYouTube`, or the playlist the Course Videos Monitor knows) counts as confirmed (origin `card`): the maintainer put it there. A course for educators (any of the roles `k-12-educator`, `higher-ed-educator`, `school-leader`) is set to `no-page` once, when it first shows up.

**Applied Skills built on a course** are stored in `skills` (mechanical): an Applied Skill counts when the course contains at least half of the modules of its study guide. On 2026-10-21 14 of the 37 Applied Skills are built on a course (the other half do not share enough modules with any course), mostly exam courses (the Defender XDR skill on SC-200T00, the Real-Time Intelligence skill on DP-700T00), and four courses that are no exam's own have one: AI-3026, MS-4018, MS-4019 and SC-5009. The join is also a way to suggest the exam lab page of a new Applied Skill.

## An entry

`{ key, uid, number, code, title, kind, exam?, examPage?, url, levels, roles, products, pathsHash, summaryHash, skills, pages, state, review?, ack?, firstSeen, lastSeen, goneSince?, missingRuns?, note? }`

- `key`: the catalog uid without `course.` (`az-104t00`), also the last part of the Learn address. `number`, `code` (the short link name), `title`, `url`, `levels`, `roles`, `products`, the two hashes are refreshed from the catalog every run.
- `pages`: `[{ page, state, origin, temporary?, confidence?, why?, note? }]`. `state`: `proposed`, `confirmed`, `rejected`. `origin`: `exam`, `replacement`, `card`, `modules`, `guide`, `groups`, `maintainer`.
- `state`: `new` (needs a decision), `active` (has a confirmed page), `no-page` (decided: none), `removed` (left the catalog).
- `review`: set by the sync when the learning path list of a course with a confirmed page changed; delete it after you looked.
- `ack`: a course that is not (or no longer) in the catalog but whose card stays (the recording still works).

A course is `removed` only after it is **missing two runs in a row**. A four-digit course that a hub YouTube card names but the catalog does not list (AI-3016, AI-3017, AZ-2007, DP-3001, DP-3011, MS-4010, PL-7008, SC-5002 on 2026-10-21) gets a `removed` entry without a `uid`; the first pass set `ack` on them because their recordings work.

## The running issue

One issue, `Learn courses: decisions needed` (label `enhancement`), created when something needs a person, commented when the list changed since the last report (the fingerprint is in `reported`), closed with a comment when nothing is left. Its tables (at most 60 rows each, the headings give the counts):

1. **Courses waiting for a decision** — kind `other`, state `new`, with roles and products, the Applied Skills built on it and the proposed pages with their reasons.
2. **Exam courses proposed for a replacement page** — AZ-400T00 on AZ-401 and the like.
3. **Confirmed pages that lack the course card** — the page, the course and the exact `<LinkCard>` to add (the Learn page card; the YouTube card too when a recording exists). Every confirmed page needs the Learn page card of the course (maintainer, 2026-10-21): a page that only has the recording's YouTube card is asked for the Learn card too, and the YouTube card is only suggested when the page has none. The card of a four-digit course is titled `Microsoft Learn <CODE> Course` and carries the catalog title as its description, because the code alone says nothing about the topic. Archived pages are never asked for a card.
4. **Courses that are not (or no longer) in the Learn catalog but hub pages still link** — remove the card from each page, or set `ack`.
5. **Temporary assignments to review** — a confirmed replacement page whose predecessor exam has retired, or whose replacement has a course of its own now.
6. **Courses to look at again** — the `review` flag.
7. **Retiring Applied Skills built on a tracked course** — from the Applied Skills Monitor's cache.

## Working the list

1. **A course waiting for a decision:** in `learn-courses.json` set a proposed page to `"state": "confirmed"` (or `"rejected"`), or set the course to `"state": "no-page"`; you can also add a page by hand with origin `maintainer`. Then add the card to the exam page (`AGENTS.md > Exam Page Anatomy`, Videos and Text tabs, the usual URL rules) and the next run sees it.
2. **A replacement proposal:** confirm it to keep the course on the replacement page for now, reject it to keep it off. A confirmed one is reported when it is due.
3. **A confirmed page without its card:** add the card from the table.
4. **A course Learn removed:** remove its card from every page the issue names; the entry stays as history.
5. Never edit `reported` by hand. The first run after a change of the format needs `FORCE_BASELINE=1` only if the failsafe below stops it.

## Failsafes (nothing is written, a failure issue instead)

- the course list cannot be read, or lists fewer than `MIN_COURSES` (60) courses;
- learnsync's data (the learning paths and modules the placement reads) cannot be read;
- more than `MAX_GONE_PCT` (30) percent of the tracked courses are missing from the catalog at once (the data changed shape). `force_baseline` accepts that;
- no exam page in the hub, or a corrupt file.

Not a failure, a warning and a note in the report: the Applied Skills list cannot be read (the skills of the entries stay as they were).

## Running it locally

```bash
node scripts/learn-courses-sync.mjs --check      # read-only
node scripts/learn-courses-sync.mjs              # writes src/data_files/learn-courses.json
```

Without `CREATE_ISSUES=1` no issue is touched and the file does not record anything as reported. Do **not** point `LEARNSYNC_DIR` at a stale checkout of learnsync: the learning paths and modules would be old. The default reads the files from GitHub. All variables are listed in the script header.

## Known limits

- A change inside a learning path (a new module) is not seen; the `pathsHash` covers the list of learning paths and modules a course names. learnsync tracks the modules.
- The relevancy is a ranking of evidence, not a verdict: `possible` proposals are often noise, which is why nothing is placed by itself.
- The `T`-numbered courses of exams that are not on `learn-exams.json` and have no hub page count as `other`.

## Seed of 2026-10-21 (what the first run found)

139 catalog courses plus 8 entries for the four-digit courses with a hub recording card that the catalog does not list: 55 exam courses (52 assigned to a hub page, 3 with no hub page: MB-800T00, MB-500T00, MB-820T00; PL-400T00 follows the rename to AB-400), 84 other courses, of which 12 were already on a hub page (their cards confirm them), 48 `no-page` (education courses and the like) and 24 waiting for a decision, and 3 exam courses proposed for a replacement page (AZ-400T00, MB-330T00, MS-102T00). The first pass set `ack` on the 8 courses the catalog does not list.

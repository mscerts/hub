# The two versions of a course: the upcoming course

_Runbook of `scripts/course-next.mjs`, `scripts/lib/course-next.mjs`, `scripts/lib/course-version.mjs` and `scripts/course-versions-backfill.mjs`. Repo-wide rules live in [AGENTS.md](../AGENTS.md). The course file is described in [courses.md](courses.md), the versions of a study guide in [study-guide-changes.md](study-guide-changes.md), the watch that tells a person a course is behind in [monitors/course-guide-watch.md](monitors/course-guide-watch.md)._

When Microsoft announces other skills for an exam, the guide's page carries the new version while the old one is still what the exam measures. A course page that follows one version is then wrong for someone: for people who sit the exam before the day, or after it. The goal is a course page with two tabs while a change is upcoming: the course for the skills measured today, and the course for the skills measured from the announced day.

**It is all built** (seven slices of the plan on the board): the data and the tooling that produce the second course, the page with two tabs and its switch on the day, what serves the version in force (the Markdown copy, Ask AI and search), the Course Guide Watch's part, the promote script and the exam page banner's link. No exam has an upcoming course yet: none of the 43 courses was behind its guide on 2026-11-16, so the tools have run on replays of real history and on test fixtures, not on a real change. "Known limits" at the end lists what to watch for the first time.

## The files

| File                                          | What it is                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/data_files/courses/<CODE>.json`          | The course in force. Unchanged format; its `inputs.guideVersion` names the guide version it follows.                    |
| `src/data_files/courses/<CODE>.next.json`     | The upcoming course. The same format, plus `pending` while it is not complete.                                         |

The tools that list the courses (`course-status.mjs --all`) only read `<CODE>.json`: a `.next.json` file is not a course of the list. The Course Guide Watch reads it beside its course and says where it stands (see below).

### `inputs.guideVersion`

A course names the version of its study guide it follows, as in the guide's history file (`src/data_files/study-guide-history/<CODE>.json`): `{ "n": 2, "asOf": null, "firstSeen": "2026-11-02" }`. It matters because the live guide page may already carry an upcoming version: a course is checked against the version it names (`node scripts/course-file.mjs validate <CODE>`), not against the page. With `guideVersion` the `guideHash` may be left out (an upcoming course has none: the history keeps no hash of a version).

- The builder (`scripts/course-build.mjs`) writes it: the newest version of the history with the course's tasks that the hub had already seen on the day the course was built.
- `node scripts/course-versions-backfill.mjs [--write]` named the version of every course that existed on 2026-11-16 the same way (43 of 43 matched). Run it again after a course was added by hand; it leaves a course that names a version alone, and reports a course no version matches (it is out of date).
- The validator checks the shape and, with the history, that the version exists and says the same `asOf` and `firstSeen`. `validate CODE.next` also requires it.

## Carrying a course forward

`node scripts/course-next.mjs build <CODE>` (add `--write` to write the file) takes the course in force and the upcoming version of the guide, the newest version of the history when it is dated ahead (`--version N` names one), and pairs the tasks with the same rules as the Study Guide Changes page (`src/utils/guide-changes/diff.mjs`):

| Pair       | Rule                                                                 | The upcoming course                                                         |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| same       | the same task key                                                    | picks and their decisions carry over untouched                              |
| moved      | the same words under another key                                     | the picks carry over under the new key                                      |
| reworded   | other words, at least 55% of the words shared (`CONFIRM_SIMILARITY`) | the picks carry over; below 80% (`CARRY_SIMILARITY`) a person confirms them |
| added      | no counterpart                                                       | no picks, listed in `pending.added`                                         |
| removed    | no counterpart in the new guide                                      | gone, with its picks                                                        |

Weights, domain and task titles come from the new guide. A skill group that has a counterpart (the same title, in the same domain first) keeps its fundamentals; one without gets `pending.foundations`. The audience profile is carried; the build says when its concepts changed. `rejected` entries follow their tasks. Nothing is read from the network.

**A rewrite is not patched.** When more than half of the tasks are new or reworded (`MAJOR_SHARE`, the "largely rewritten" rule of the Changes page), or a domain or a skill group appeared or went, `build` stops and says why: build the course with the whole pipeline ([course-build.md](course-build.md)) from the upcoming version. `--force` patches anyway.

### `pending`

```json
"pending": {
  "added": ["<task key>"],
  "confirm": [{ "key": "<task key>", "was": "<old wording>", "similarity": 0.6 }],
  "foundations": ["<domain>/<group>"]
}
```

The upcoming course is **complete** when there is no `pending` (`isComplete`). Only a complete one is shown as a tab (see "The page with two versions").

- `node scripts/course-next.mjs status <CODE>` lists what is left and validates the file against its version.
- `confirm <CODE> (--all | TASKKEY...)`: the carried picks of a reworded task still fit.
- `reject <CODE> TASKKEY`: they do not; they go and the task is built like an added one.
- `merge <CODE> --from FILE`: the picks of the tasks in `pending.added` and the fundamentals of the groups in `pending.foundations` are taken from a course file the pipeline built from the same version (a built course with only those tasks judged is enough), and cleared from `pending`.

Every command that writes validates first and writes nothing when the file would not be valid.

### The decisions

The decisions file (`src/data_files/course-decisions/<CODE>.json`) is keyed by task, and a moved or reworded task has a new key. Nothing is written to it while the course in force still uses the old keys. `rekeyDecisions` (`scripts/lib/course-next.mjs`) moves the decisions to the new keys and drops those of removed tasks; it is for the moment the upcoming course takes over (`course-promote.mjs`, below). The picks of the upcoming file carry their own `decision`, so nothing is lost meanwhile.

## The page with two versions

`node scripts/course-file.mjs render <CODE> --out <page>` writes the page of the course in force, as always; when `<CODE>.next.json` exists beside it, is valid against the version it names and is **complete**, it writes the page with two versions instead (`renderCourseVersions`, `scripts/lib/course-render.mjs`). An upcoming course that is not complete, or whose version states no day, leaves the page as it was and the command says why; a broken one stops the render. A page that was rendered this way has `<CourseVersions>` (`src/components/CourseVersions.astro`) around the two courses.

- **Tabs.** "Current, until <day before>" (first, the default) and "Upcoming, from <day>". Each holds a whole course, with its own audience profile.
- **Headings are plain HTML** with ids that start with `current-` or `upcoming-`, so "On this page" does not list every domain twice (it lists none while a change is upcoming); the links between the tasks of one version use those ids.
- **Marks** come from the difference between the two courses (`versionMarks`, the same pairing as the build): a new task (green, underlined, badge "New from <day>"), a reworded task (green and underlined in the upcoming tab, its old wording with "Reworded from <day>" in the current tab), a task that leaves (red, badge "Leaves <day>"), and cards only one version has: `LinkCard`'s `change="added"` or `"removed"` and `tag` give a tint and a text label ("New from <day>", "Until <day before>"). The cards of a new or leaving task are not marked (the heading says it). Colour is never the only cue, the same rule as the Changes page. When more than half of the tasks are new or reworded (a course built with the whole pipeline) nothing is marked and a note says the course was largely rewritten.
- **The switch on the day.** From the effective day (UTC, the day itself counts) the component renders only the upcoming course, with no tab strip, no marks and no notes. The build decides, and a script decides again in the browser (the same `daysUntil` as the exam page's banner), so a page built before the day is right on it. The next build after the day renders the same, and `course-promote.mjs` (below) replaces the course in force by the upcoming one and renders the single page again.
- **`#upcoming`** opens the upcoming tab (the exam page's banner links it, see below).
- A page that is not rendered this way is byte for byte what `render` wrote before: `render` of all 43 courses was compared with their committed pages.
- `node scripts/course-source.mjs <CODE> --check <page>` reads markdown headings; do not point it at a page with two versions (check the course files with `course-file.mjs validate` instead).

### What serves the version in force

- **The Markdown copy** (`/certs/courses/<code>.md`, `serializeMdx` in `src/utils/markdown/serializeMdx.ts`) of a page with two versions is the course in force on the day the site is built: the first tab's course until the effective day, the upcoming course from it, as ordinary Markdown headings, without the marks, their badges or the notes about them. The copy is static, so after the effective day it changes at the next build, not at midnight; the page itself flips in the browser.
- **Ask AI** (the page actions, `DocsPageActions.astro`) points an assistant at that Markdown copy on every course page (`/certs/courses/...`), not at the HTML with both tabs. Exam pages are unchanged.
- **Search** (Pagefind) does not index the upcoming tab while it is a tab (`data-pagefind-ignore` around it in `CourseVersions.astro`), so a search finds the course in force; from the effective day the page is rendered without the tab and the upcoming course is indexed. The wrapper is in the built HTML; the index itself was not queried for it.

### Taking over: `course-promote.mjs`

`node scripts/course-promote.mjs <CODE>` says what it would do; `--write` does it, once the day the upcoming skills count from has come (`--force` skips the day, for a version that states none). It refuses an upcoming course that is not valid against the version it names, one that is not complete, or one whose day has not come. It then:

1. writes `<CODE>.next.json` as `<CODE>.json` (the old course stays in git's history) and deletes the upcoming file;
2. moves the decision list to the new task keys with `rekeyDecisions` and drops the decisions of tasks and groups that are gone (the keys come from `rekeyBetween`, computed from the two courses on the day);
3. renders `src/content/docs/courses/<code>.mdx` again, now the new course alone.

The page needs no promotion to be right on the day (it flips by itself); the script keeps the files in step. The Course Guide Watch's "take over" issue points at it. The decisions are the part that cannot be undone by the page: run it before the next rebuild of the course.

### The link from the exam page

While the change is upcoming and the upcoming course is complete, the exam page's study guide banner has a second link, "See the course for the upcoming skills", to the course page with `#upcoming` (the tab opens). It is in `GuideChangeBanner.astro`, fed by `guideChangeFor` (`src/utils/guide-change.mjs`, which loads the `.next.json` files at build time; the rule is `src/utils/guide-changes/course-link.mjs`). The banner's script hides the link when the change is in effect, because the tab no longer exists then.

### The Course Guide Watch

The watch ([monitors/course-guide-watch.md](monitors/course-guide-watch.md)) reads `<CODE>.next.json` beside the course and compares it with the upcoming version: with no file it asks for `course-next build` (or, for a rewrite, the whole pipeline); with a file that is not complete it lists what is left; with one that is out of date it lists the differences; with a complete one it **closes** the issue (the page shows both versions until the day). On the day, with the course in force behind and the upcoming course complete, it raises a "take over" issue that points at `course-promote.mjs`.

## Decisions of the maintainers (2026-11-16)

- Two files per exam, not a list of versions inside one file: the whole course toolchain assumes one course per exam, and the switch becomes a file move.
- The upcoming tab is shown only when the upcoming course is complete.
- A change of weights alone gets no second tab (the Course Guide Watch already ignores it).
- The Markdown copy of a course page, Ask AI and the search index serve the version in force today.
- Headings inside tabs are plain HTML, so the "On this page" list does not repeat both versions (the domains are not in it while a change is upcoming; accepted for now).
- The page switches on the effective day at build time (and in the browser), like the NEW badge and the banner on the exam page, so nobody has to act on the day; a script then promotes the upcoming file.

## Known limits

Things to watch the first time a real change comes:

- **"On this page"** lists none of the domains of a page with two versions (the headings inside the tabs are plain HTML on purpose). Accepted by the maintainers for now.
- **The browser-side switch** (a page built before the effective day, opened on or after it) uses the same `daysUntil` as the exam page's banner and was tried only in its build-time form; the first real change is its first real test.
- **The Markdown copy is static**: after the effective day it changes at the next build, not at midnight.
- **Ask AI** points at the Markdown copy on every course page, not only on pages with two versions (the page actions cannot tell which have versions).
- **Decisions are moved at promotion**, not before; a full rebuild of the course in force during the window still uses the old keys, which is right.
- **`course-status.mjs`** still compares a course with the live guide page; the Course Guide Watch is the check that knows about versions.
- **Replays, not a real change**: the page, the marks and the commands were checked on DP-700's real history replayed as an upcoming change (one direction of it) and on fixtures.

## Tests

`tests/scripts/course-next.test.mjs` (the pairing, the update and rewrite rules, the carried picks, the pending list and its commands, the decision keys, the marks and labels of the page with two versions, its rendering, and the command lines on the example course) `course-version.test.mjs` (the version of a course, the validator's new checks and the backfill), `course-promote.test.mjs` (the take-over, its refusals and the decision keys), `course-link.test.mjs` (the banner's link) and `serialize-mdx.test.mjs` (the Markdown copy of a page with two versions, before and from the effective day, and of an ordinary page). Offline; no network and no learnsync.

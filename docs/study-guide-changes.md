# Study Guide Changes

_Runbook of the Study Guide Changes pages. Repo-wide rules live in [AGENTS.md](../AGENTS.md); the monitor that feeds the pages is described in [monitors/new-exam-monitor.md](monitors/new-exam-monitor.md)._

Microsoft's study guide page only ever shows one version of what an exam measures. When Microsoft publishes a new version, the old one disappears from the page, often before the new one takes effect, and nothing says what moved. The hub keeps every version of every covered guide and shows the difference.

For every exam page there is a page `/certs/changelog/<code>/` (for example `/certs/changelog/ab-100/`). Every exam page links to it with a **`<CODE> Study Guide Changes`** card directly under its Study Guide card, and, while a change is upcoming or recent, shows a banner under the exam's tagline.

## Where things are

| What                                                                                   | Where                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The versions of each guide (data, committed)                                           | `src/data_files/study-guide-history/<CODE>.json`                                                                                                                                                                                                                  |
| The store: version rules, files, `recordGuides`                                        | `scripts/lib/guide-history.mjs`                                                                                                                                                                                                                                   |
| One-off rebuild of the files from the git history of the tracker                       | `scripts/study-guide-history-backfill.mjs`                                                                                                                                                                                                                        |
| Comparing two versions                                                                 | `src/utils/guide-changes/diff.mjs` (uses `scripts/lib/course-guide.mjs` to read a guide)                                                                                                                                                                          |
| What state a history is in on a day (current, upcoming, previous, banner)              | `src/utils/guide-changes/state.mjs`                                                                                                                                                                                                                               |
| The HTML of a change page (tabs, tables, inline diff)                                  | `src/utils/guide-changes/render.mjs`                                                                                                                                                                                                                              |
| Exam code of a docs entry, address of a change page                                    | `src/utils/guide-changes/codes.mjs` (pure; `src/utils/guide-change.mjs` re-exports it and adds `guideChangeFor`)                                                                                                                                                  |
| The 30-day window and the banner sentences (pure, shared by the build and the browser) | `src/utils/guide-change-date.mjs`                                                                                                                                                                                                                                 |
| Loading the history files in Astro                                                     | `src/utils/guide-changes/load.mjs` (`import.meta.glob`, so Vite only: scripts and tests import the other modules)                                                                                                                                                 |
| The route                                                                              | `src/pages/certs/changelog/[code].astro`                                                                                                                                                                                                                          |
| The banner                                                                             | `src/components/docs/GuideChangeBanner.astro`, rendered by `DocsShell.astro`                                                                                                                                                                                      |
| The cards on the exam pages                                                            | `scripts/study-guide-changes-cards.mjs`                                                                                                                                                                                                                           |
| Tests                                                                                  | `tests/scripts/guide-history.test.mjs`, `guide-changes.test.mjs`, `guide-change-date.test.mjs`, `study-guide-changes-cards.test.mjs`, and the monitor hook in `new-exam-check.test.mjs`; small guides for them in `tests/fixtures/study-guide-changes/guides.mjs` |

## The data

The [New Exam Monitor](monitors/new-exam-monitor.md) already stores the normalized text of every covered study guide (`studyGuides[].lines` in `src/data_files/learn-exams.json`: one string per line, headings as `## Title`, bullets as `- text`) but overwrites it when the guide changes. After each run it also hands the stored guides to `recordGuides`, which appends a version to the guide's history file when the live version changed. Nothing else writes these files, apart from the backfill below.

A history file is `{ schemaVersion, code, versions: [{ n, asOf, firstSeen, lines, priorOnPage?, corrections? }] }`:

- `lines` is only the skills part of the guide: the audience profile, skills at a glance, domains, groups and skills. Notices and "Updates to the exam" are left out because the change pages never show them (the monitor still alerts on them through its own hash).
- `asOf` is the date in the heading of the version ("Skills measured as of October 14, 2026" gives `2026-10-14`), or `null` when the heading states none. About a third of the guides have no date.
- `firstSeen` is the UTC day the monitor first saw the version.
- `priorOnPage` is Microsoft's own "Skills measured prior to ..." section, when the page carried one with that version. It has no date of its own.
- `corrections` lists the earlier text of a version that Microsoft edited without changing its date: `[{ day, before }]`.

The files are written with one row per line, so a git diff of a new version reads like a diff of the guide. A corrupt file makes the monitor stop with the file name (it never overwrites it); `tests/scripts/study-guide-changes-cards.test.mjs` validates every file in CI.

### Version rules (`recordVersion`)

The version live on Microsoft's page is the first "Skills measured" section of the guide. A version is identified by its date, because that is what a visitor sees:

| The guide now                                      | Result                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| the same text as the latest version                | nothing happens                                                                                                              |
| a different `asOf` (also when only the date moved) | a new version is appended                                                                                                    |
| the same `asOf`, different text                    | an in-place correction: the old lines go into `corrections`, which History shows as "corrected"                              |
| no date, different text                            | a new version (two undated versions are never "the same date")                                                               |
| an `asOf` earlier than the previous version's      | a new version: the page wins, whatever the dates say (DP-750 and DP-800 went from "October 19, 2026" to "March 11/12, 2026") |

### Rebaselined guides are not recorded

When a run accepts a guide silently (`FORCE_GUIDE_BASELINE` or `FORCE_BASELINE`, used after a change in how Learn's markup is normalized), the lines changed in form, not in content. The monitor leaves those guides out of the history for that run, otherwise a normalization change would show up as a version Microsoft never published. A genuine change that lands in the same run is picked up from the next real change onward, as a comparison with the last recorded version.

### Rebuilding the files

`node scripts/study-guide-history-backfill.mjs --ref origin/main` replays every commit that touched the tracker, oldest first, through the same rules and prints the events; add `--write` to write the files (a dry run is the default; `--dir` chooses another folder). It was run once to seed the 56 files (the history starts with the first commit that stored guide text, so earlier versions are not available). Running it again over the whole history rebuilds every file from scratch: use it only if the files were lost or the rules changed, and read the dry run first.

## What a visitor sees

### Tabs

**Changes** is always first and the page's default, even with nothing to show (it then says "No changes recorded"). Then **Current**, **Upcoming** (only when a version dated in the future exists), **Previous** and **History**. An exam whose guide has not been recorded has one Changes tab that says so. Notices are never shown.

The state of a history on a day (`versionState`):

- _upcoming_: the newest version, when its date is still ahead;
- _current_: the newest version not dated in the future;
- _previous_: the version recorded before the current one, else Microsoft's own "prior to" section (the Previous tab says which);
- the Changes tab compares current with upcoming when one exists, otherwise previous with current.

### The Changes view depends on the kind of change (`changeKind`)

| Kind         | Meant when                                                                            | Shown                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none`       | nothing but the date changed                                                          | a note that no skill changed                                                                                                                                                                                             |
| `weights`    | only the weight of domains changed                                                    | a table (Domain, Now, From `<date>`) and a line that no skills changed; for an upcoming change a "what this means for you" hint                                                                                          |
| `topics`     | skills or the audience profile changed                                                | a legend, counts and the whole guide inline: additions green and underlined (`<ins>`), removals red and struck through (`<del>`), a reworded skill as a word diff; the audience dropdown opens when the audience changed |
| `rewritten`  | more than half of the new guide's skills are new or reworded (`REWRITTEN_SHARE`, 0.5) | a "largely rewritten" sentence, counts, a Domains table (Before, Now) and every change behind a closed "Show every change" dropdown                                                                                      |
| `unreadable` | a version cannot be parsed as a guide                                                 | a plain line comparison                                                                                                                                                                                                  |

Skills are paired old to new by word overlap (plurals ignored) above `REWORD_THRESHOLD` (0.55; 0.7 for audience lines); domains and groups are paired by exact title. The thresholds were checked against the real history (21 of 21 hand-checked pairs correct): change them only together with the cases in `tests/scripts/guide-changes.test.mjs`.

### Dates

The date of a change is the date the new version states. For an undated version, or one dated earlier than the version it replaced, it is the day the monitor first saw it, and the page then says "We saw the skills measured change on `<date>`". A date in the future reads "changes on `<date>`".

### The banner and the 30-day window

The banner appears on the exam page under the tagline while a change is upcoming or recent and a real change exists (`kind` is not `none`). It has the summary of the change on its own line and a "See what changed" link. The window is `GUIDE_CHANGE_RECENT_DAYS` (30) days: the effective day is day 0 and the last day shown is day 29. After that the banner disappears at the next build; the change page stays.

The build writes the banner's text, but the day count ("in 6 days", "3 days ago") is worked out again in the visitor's browser by the script in `GuideChangeBanner.astro`, using the same pure module (`guide-change-date.mjs`), so a page built a day ago is still exact and a banner past its window hides itself. No day count is written into a change page.

Because the build decides what a page shows on the day it runs, a banner starts and stops at the first build on or after the day. The site is rebuilt by every push; if no push comes, the browser script still hides an expired banner and keeps the count right.

## Entry points

- **Every exam page** has the card `<CODE> Study Guide Changes` directly under its Study Guide card inside Get Started. `node scripts/study-guide-changes-cards.mjs` adds missing cards, `--check` lists problems (missing, misplaced, no Study Guide card to anchor to); `findProblems` is a test, so an exam page without its card fails CI.
- **A new exam page** gets the card from `scripts/new-exam.mjs`, and the change page exists as soon as the page does. Until the monitor records the guide the change page says "We have not recorded this study guide yet."
- **Retired and renamed exams** (AZ-800, AZ-801, PL-400) keep their history files but have no exam page, so they have no change page.
- The pages are **not indexed**: `noindex` in the layout and no sitemap entry (`astro.config.mjs`, `/certs/changelog/`). The site search still finds them. They have no Markdown endpoint, and the "View as Markdown" action is hidden on them.

## Maintaining it

- The history is an ordinary part of the repository: the monitor's workflow commits `src/data_files/study-guide-history` together with the tracker. The commit step is covered by `tests/scripts/workflow-commit-steps.test.mjs` and the commit tests of `new-exam-check.test.mjs`.
- To change what counts as a version, edit `recordVersion`, update the table above and the tests in `guide-history.test.mjs`. Files that were written under the old rules stay as they are unless you rebuild them.
- To change the window, edit `GUIDE_CHANGE_RECENT_DAYS`; the test pins it to 30 on purpose, update it and this page together.
- If a guide's text could not be parsed (a change page says the wording changed and shows a line comparison), look at the stored lines with `parseGuide` in `scripts/lib/course-guide.mjs`: usually a markup change on Learn that the monitor's normalization has to learn.

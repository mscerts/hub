# Study Guide Changes

_Runbook of the Study Guide Changes pages. Repo-wide rules live in [AGENTS.md](../AGENTS.md); the monitor that feeds the pages is described in [monitors/new-exam-monitor.md](monitors/new-exam-monitor.md)._

Microsoft's study guide page only ever shows one version of what an exam measures. When Microsoft publishes a new version, the old one disappears from the page, often before the new one takes effect, and nothing says what moved. The hub keeps every version of every covered guide and shows the difference.

For every exam page there is a page `/certs/changelog/<code>/` (for example `/certs/changelog/ab-100/`). Every exam page links to it with a **`<CODE> Study Guide Changes`** card directly under its Study Guide card, and, while a change is upcoming or recent, shows a banner under the exam's tagline.

## Where things are

| What                                                                                   | Where                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The versions of each guide (data, committed)                                           | `src/data_files/study-guide-history/<CODE>.json`                                                                                                                                                                                                                                                  |
| The store: version rules, files, `recordGuides`                                        | `scripts/lib/guide-history.mjs`                                                                                                                                                                                                                                                                   |
| One-off rebuild of the files from the git history of the tracker                       | `scripts/study-guide-history-backfill.mjs`                                                                                                                                                                                                                                                        |
| One-off read of the guides of retired exams, for the comparisons                       | `scripts/study-guide-history-retired.mjs`                                                                                                                                                                                                                                                         |
| Comparing two versions                                                                 | `src/utils/guide-changes/diff.mjs` (uses `scripts/lib/course-guide.mjs` to read a guide)                                                                                                                                                                                                          |
| What state a history is in on a day (current, upcoming, previous, banner)              | `src/utils/guide-changes/state.mjs`                                                                                                                                                                                                                                                               |
| The HTML of a change page (tabs, tables, inline diff)                                  | `src/utils/guide-changes/render.mjs`                                                                                                                                                                                                                                                              |
| Exam code of a docs entry, address of a change page                                    | `src/utils/guide-changes/codes.mjs` (pure; `src/utils/guide-change.mjs` re-exports it and adds `guideChangeFor`)                                                                                                                                                                                  |
| Which exam replaced which, and how their areas changed (judged by hand)                | `src/utils/guide-changes/compare.mjs` (pairs), `compare-areas.mjs` (areas)                                                                                                                                                                                                                        |
| The 30-day window and the banner sentences (pure, shared by the build and the browser) | `src/utils/guide-change-date.mjs`                                                                                                                                                                                                                                                                 |
| Loading the history files in Astro                                                     | `src/utils/guide-changes/load.mjs` (`import.meta.glob`, so Vite only: scripts and tests import the other modules)                                                                                                                                                                                 |
| The route                                                                              | `src/pages/certs/changelog/[code].astro`                                                                                                                                                                                                                                                          |
| The banner                                                                             | `src/components/docs/GuideChangeBanner.astro`, rendered by `DocsShell.astro`                                                                                                                                                                                                                      |
| The cards on the exam pages                                                            | `scripts/study-guide-changes-cards.mjs`                                                                                                                                                                                                                                                           |
| Tests                                                                                  | `tests/scripts/guide-history.test.mjs`, `guide-changes.test.mjs`, `guide-change-date.test.mjs`, `study-guide-changes-cards.test.mjs`, `guide-compare-areas.test.mjs`, and the monitor hook in `new-exam-check.test.mjs`; small guides for them in `tests/fixtures/study-guide-changes/guides.mjs` |

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

### Comparing an exam with its replacement

When one exam replaces another, the change pages of both get a **Compared to `<CODE>`** tab right after Changes: the current study guide of the old exam against the current one of the new exam, shown like a "rewritten" change (counts, a Domains table with both exams' weights and skill counts, and every difference in place behind a closed dropdown). It uses the same pure code as the other views (`compareTab` in `render.mjs`), with `diffVersions(..., { titleThreshold: 0.5 })` so that domains and groups the two exams word differently are paired by similar title (the old title then shows as a word diff) instead of counted as one removed and one added.

The pairs are listed by hand in `src/utils/guide-changes/compare.mjs`. A pair is an exam that retired in the last 12 months (or retires soon) and the replacement Microsoft names: the Skills Hub posts that announce the retirements, the retiring-exams tracker and Learn's "Recently retired exams" table are the sources, and each pair's `retired` field carries the date from that table when the tracker has none. Today: AZ-400 to AZ-401, AZ-800 and AZ-801 to AZ-802, MB-330 to AB-330, MS-102 to AB-650, PL-400 to AB-400 (a rename), AI-102 to AI-103, AI-900 to AI-901, DP-100 to AI-300, AZ-204 to AI-200, AZ-500 to SC-500, MB-280 to AB-210 and PL-200 to AB-410. Retired exams with no replacement (PL-600, MB-700, MB-335, MB-240, PL-500, MS-900, MB-910, MB-920) have none. The tab appears on the replacement's page and on the page of each replaced exam that still has one (most of them are archived, so only the replacement shows it).

When one exam replaces two, `mergeGuides` puts the two old guides together as one (audience profiles, skills-at-a-glance and domains one after the other) and the Domains table says which exam each old domain came from. A pair can set its own `titleThreshold` (AZ-802 uses 0.35, because it shortens "Active Directory Domain Services (AD DS)") and a `blurb` that replaces the note's first sentence (AB-400 is a rename), and its areas are in `compare-areas.mjs`. A tab is left out when a guide has not been recorded; when the two guides have the same skills, weights and audience profile it says so instead of listing differences; when no domain of the two exams is the same (a new scope), the weights row says they are not comparable.

**How the areas changed (judged by hand).** Two exams rarely keep the same domains: three security domains of MS-102 became one broader domain of AB-650. Matching domains by title, or skills by word overlap, cannot see that, and a word-overlap heuristic alone matched too loosely, so for every pair someone reads the two guides side by side and writes down how the areas became the new ones in `src/utils/guide-changes/compare-areas.mjs`: entries of `{ from: [old domains], to: [new domains], note, label? }`. One old domain to one new one is a carry-over (or a rename), several old to one is a merge, one old to several new a split, no `to` an area that is gone, no `from` an area that is new; the `note` says what changed in plain words (weights, groups gone or added, what became higher level), and a `label` replaces the automatic bold word when "Renamed" would mislead. Two flags handle the awkward cases: `minor` marks an entry that only says where a small part of a domain went (it lets skills move there and shows in the table, but does not pair the domains and stays out of the notes in "Skills at a glance", which then say "mostly not in"), and `pair: false` keeps an entry from pairing its domains when two old domains went to the same new one and only one is its real counterpart. Every claim in these notes was checked against the skills of both guides, not only the titles; the counts say "no close match" rather than "removed" because the skills are matched by topic and a heavily reworded one can be missed. The file's header has the details.

The areas drive the comparison tab in four ways. They pair the domains (the one-to-one entries, whatever the titles). They decide where a skill may count as moved: skills left over without a counterpart in their group are matched across domains by topic (`topicOverlap` in `diff.mjs`: the meaningful words two skills share, as a share of the shorter skill, at least two of them and a score of `MOVE_THRESHOLD`, 0.8), but only between an old and a new domain that an entry connects. A matched pair is one skill that **moved**: it is no longer counted as removed and added, it shows its old wording as a word diff with a grey "← from <old domain>" (and "→ now in <new domain>" on the old side), both names being links to that area's heading in the full guide, and it counts toward how much of the guide changed. They give the "How the areas changed" table (old areas with weight and skill count, new areas, label and note; the names link to the areas in the full guide, and a link into the closed "Show every difference" dropdown opens it, see the script of `[code].astro`). And they put a note after each line of "Skills at a glance" in the full guide (merged from, merged into, split from, split into, not in, new), and "→ <new domain>" in place of the new weight of a removed domain in the Domains table. Only the comparison tab uses them (`moveThreshold` is off for the ordinary Changes view). A pair with no areas (AB-400, whose domains are those of PL-400) is compared by title alone.

**One level down: groups, and broader skills.** A domain pairing is too coarse where a guide covers a topic with fewer, higher-level skills: MS-102 implemented sensitivity labels, retention and DLP policies in detail (7 skills), AB-650 asks to identify the requirements for them (a group of 5). For those pairs `src/utils/guide-changes/compare-groups.mjs` pairs the groups the same way: entries of `{ from: [old groups], to: [new groups], note, label?, broader? }`. The pairing narrows where a skill can count as moved: a skill of an old group listed there can only go to a group the same entry names, with a lower bar (`GROUP_MOVE_THRESHOLD`, 0.5) because a person already said the groups belong together. `broader: true` says the new group covers the old one at a higher level: the skills of the old group that no new skill matches are then shown as **covered** by that group (grey, with "→ covered at a higher level by <group>", the group name linking to its heading) and not as removed. Old groups that no entry lists keep the domain-level behaviour, so a pair needs no complete list (every new group must be listed, a test checks it). The tab gets a closed "Group by group" dropdown with the table.

Skills are matched many to one: each removed skill goes to the new skill it is closest to (`topicOverlap`'s `jaccard`, the shared words as a share of both skills together), and a new skill can take several old ones. The new skill then says "← from <domain> and N more skills of the old guide". Matching one to one let a short old skill ("Configure Endpoint DLP") take the broad new skill and leave the skill it really belongs to unmatched.

When Microsoft changes a guide of a pair, `tests/scripts/guide-compare-areas.test.mjs` fails (a title the areas name is gone, or a domain is in no area); the page itself skips entries that name a missing title, so nothing breaks, the areas just need another read. Add the areas of a new pair together with the pair.

**The old guides.** The monitor only records exams the hub covers, but Microsoft keeps the study guide of a retired exam on Learn, with a "This exam was retired" notice. `node scripts/study-guide-history-retired.mjs [CODE ...] [--write]` reads them once with the monitor's own reader (`parseStudyGuide`) and records each as version 1 (`firstSeen` is the day it was pulled; a retired guide does not change). With no codes it takes every replaced exam of `comparisonPairs` that has no history file yet, one request a second; without `--write` it only prints what it would record. Run it when you add a pair whose old exam is not recorded yet.

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

# Course Guide Watch

_Runbook of the Course Guide Watch. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the other monitors are listed in the [index](README.md). The courses are described in [courses.md](../courses.md), the versions of a study guide in [study-guide-changes.md](../study-guide-changes.md)._

A course (`src/data_files/courses/<CODE>.json`) follows its exam's study guide task for task. When Microsoft changes the skills an exam measures, the course is wrong until someone rebuilds it, and nothing said so: the rebuild check (`node scripts/course-status.mjs`) is a command a person has to remember to run. The Course Guide Watch runs every day, compares every course with the versions of its guide that the [New Exam Monitor](new-exam-monitor.md) records, and keeps **one issue per exam** whose skills changed, saying when the new skills count and what changes for the course.

It reads only the repository: the course files and `src/data_files/study-guide-history/<CODE>.json`. It asks Microsoft Learn nothing, writes nothing into the repository and keeps no tracker, so a run can be repeated and says the same.

- **Workflow:** `.github/workflows/course-guide-watch.yml` — daily at 08:15 UTC (cron `15 8 * * *`, after the New Exam Monitor's 06:45 UTC run has recorded the guides of the day), on a person's push to `main` that changes a course file or a history file (so the issue of a course that was just updated closes at once; the New Exam Monitor's own commits start no workflow, the schedule picks them up), and by hand with a `dry_run` and a `force` checkbox. Permissions `issues: write` and `contents: read`; runs queue and never cancel each other; 10 minute timeout. It never pushes, so it is not one of the "workflows that push to `main`".
- **Script:** `scripts/course-guide-watch.mjs` — Node, no dependencies. It reuses `planGuideChanges` of `scripts/lib/course-status.mjs` (the comparison the rebuild check prints), `versionState` of `src/utils/guide-changes/state.mjs` (which version is current and which is upcoming, the same rule as the Study Guide Changes pages), `readHistory` of `scripts/lib/guide-history.mjs` and the `gh` helpers of `scripts/lib/gh.mjs`.
- **Tests:** `tests/scripts/course-guide-watch.test.mjs`, fully offline: small guides from `tests/fixtures/study-guide-changes/guides.mjs`, an in-memory `gh`, and the script run for real against a fake `gh` that keeps its issues in a file. One test reads the repository's own courses and fails when one of them cannot be compared with its guide. The steps of the workflow that raise and close the failure issue are checked in `tests/scripts/failure-issue.test.mjs`.

## What counts as a change

Only the **tasks** of the guide: a task that is new, gone, reworded, moved to another skill group or domain, or in another order. That is what makes a course wrong: a task without picks, or picks under a task the exam no longer has.

A new "skills measured as of" date, new domain weights, a changed audience profile or a changed notice alone open nothing. The course's tasks are still the guide's; the weights and the date are refreshed by the next rebuild. (The 16 guides that changed between 2026-11-04 and 2026-11-14 were all of this kind: practice assessment notices and a product name note.)

## Which version a course is compared with

A history file holds every version of a guide with the day it says its skills are measured from (`asOf`) and the day the hub first saw it (`firstSeen`). On the day of the run:

| The history has | The course is compared with | Status |
| --- | --- | --- |
| a newest version dated **in the future** whose tasks differ from the course | that version | `upcoming`: the skills change on that day |
| a newest version dated in the future whose tasks the course already has | that version | `current` (the report of the run notes that the course is ahead of what is measured today) |
| no version dated in the future | the newest version | `changed` when its tasks differ, else `current` |
| no recorded version at all | the guide text the tracker stores (`learn-exams.json`) | `changed` or `current` |
| nothing that parses as a guide | nothing | `unknown`: no issue is opened and none is closed |

The day a change counts from is the date the version states. For a version without a date, or dated before the version it replaced, it is the day the hub first saw it, and the issue says so (the same rule as the Study Guide Changes pages).

## The issue

Title `Course <CODE>: the study guide's skills changed`, label `courses` (created when the repository lacks it), no assignee. One issue per exam; the title never changes, so the same issue is kept from the announcement to the day the course is updated.

The text says:

- when the new skills count: "measured from **January 15, 2027**. They are not in effect yet" for an upcoming change, "in effect since ..." otherwise;
- which version the course was built for, with links to the course page and to the exam's Study Guide Changes page (the word-for-word comparison);
- what changes for the course, task by task: new tasks (they need picks), tasks that are gone (with the number of picks that leave), tasks that look reworded (a removed and an added task that share most of their words, with the picks at stake: a person decides whether they carry over), tasks that moved (the picks carry over), changed weights, and how many tasks stay as they are;
- what to do (below).

**Every run:**

- The course has the tasks of the version to follow: an open issue is closed with a comment; no issue means nothing to do.
- It does not, and no issue is open: the issue is created.
- It does not, and the issue is open and already says the same: nothing is written. A daily run is silent while nothing changes.
- It does not, and what the issue has to say changed (the day came, so "upcoming" became "in effect"; Microsoft changed the guide again; a part of the course was updated): the text is **rewritten in place** and a short comment says that it was. The text carries a hidden fingerprint of what it says (`<!-- course-guide-watch:... -->`); a different fingerprint is what makes a run rewrite it. Keep that line when editing an issue by hand, or the next run rewrites the text.

## Failsafes

- **A file that cannot be read stops the run.** A course file that is not JSON or not a course of that exam, or a history file that does not validate, ends the run with exit code 1 before any issue is created, rewritten or closed. It is never read as "nothing changed": a run that could not look closes nothing.
- **Too many new issues at once are not believed.** More than 5 courses that would get a new issue in one run (`COURSE_GUIDE_WATCH_MAX_NEW`) stop the run the same way: a change in how the guides are read (the monitor's normalization, the parser) would make every course differ at once. Look at one of them with `node scripts/course-status.mjs <CODE>`; when the changes are real (Microsoft does rewrite a family of exams together), run the workflow by hand with `force` ticked.
- **A failed run raises one failure issue**, `Course Guide Watch Failed` (label `bug`), through `scripts/failure-issue.mjs`: one comment a day at most while it keeps failing, closed by the next healthy run.
- **A version that does not parse is no evidence.** It leaves the course `unknown`; the Study Guide Changes page of that exam shows the same problem ([study-guide-changes.md](../study-guide-changes.md), "Maintaining it").

## Environment

`GH_TOKEN` (the job token), `CREATE_ISSUES` (the workflow sets it; without it nothing is created, rewritten or closed), `DRY_RUN=1` (the same, whatever `CREATE_ISSUES` says), `FORCE=1` (skip the too-many-at-once failsafe), `COURSE_GUIDE_WATCH_MAX_NEW`, `COURSES_DIR`, `HISTORY_DIR`, `LEARN_EXAMS_FILE`, `TODAY` (YYYY-MM-DD), `SITE_URL` (default `https://msfthub.com`), `REPORT_FILE`, `ERROR_FILE`, `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`/`GITHUB_RUN_ID` (a link to the run), `GITHUB_OUTPUT` (`check_failed`, `changed`), `GITHUB_STEP_SUMMARY`, `GH_CLI_SCRIPT` (tests only: a fake `gh`).

## Trying it

```bash
node scripts/course-guide-watch.mjs                      # the report of the run, and the text of every issue it would raise
TODAY=2027-01-15 node scripts/course-guide-watch.mjs     # the same on another day (an upcoming change is in effect then)
```

Without `CREATE_ISSUES=1` nothing on GitHub is touched. After the workflow is on `main`, "Run workflow" with `dry_run` ticked prints the same in the job summary.

## Working an issue

1. `node scripts/course-status.mjs <CODE>` prints the same plan with what Learn changed for the picks since the course was built.
2. Run the chain of [course-playbook.md](../course-playbook.md) for the exam: candidates, judging, gates. The remembered decisions (`src/data_files/course-decisions/<CODE>.json`) apply themselves to every task whose key is unchanged, the hand-placed picks and pointer notes included ([course-gates.md](../course-gates.md), "Pages added by hand, and pages placed by hand").
3. A decision is remembered per task key, and a reworded or moved task has a new key. For each task the issue lists as reworded or moved, copy the decisions that should carry over to the new key in the decisions file and leave out what no longer fits. Nothing does this by itself.
4. `node scripts/course-build.mjs <CODE>`, move the result to `src/data_files/courses/<CODE>.json`, then `node scripts/course-file.mjs validate <CODE> --live` and `render`.
5. **An upcoming change waits for its day.** Until then the page must follow what the exam measures, so the new version is prepared on a branch and merged on that day; the issue is rewritten on that day ("in effect since"), which is the reminder. A change that is already in effect is merged as soon as it is ready.
6. The issue closes itself at the first run after the course has the tasks of the newest version.

## Not covered

- **Two versions on one course page.** While a change is upcoming, the page shows the course for the skills measured today and nothing of what comes; the Study Guide Changes page and the banner on the exam page are what tell a visitor. A course page with a tab for the current skills and a tab for the upcoming ones needs a second course file per exam and changes to the validator, the builder and the renderer; it is not built.
- **What Learn changed.** A module a pick relies on that changed, left the official course or moved is the other half of the rebuild check (`course-status.mjs`: `review`, and `stale` for a pick that has to be replaced). It needs learnsync's data and Learn's catalog API, which this watch does not read.
- **Exams without a course.** An exam whose guide changes and that has no course file is the New Exam Monitor's business alone.
- **Not in the Tests Review Reminder's table.** `MONITORS` in `scripts/tests-review-reminder.mjs` lists the monitors that must have raised a real alert before their tests are offered for removal; this one is not on it, so it neither delays that reminder nor is covered by it.

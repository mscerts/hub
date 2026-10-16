# ESI Check Reminder

*Runbook of the ESI Check Reminder. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the other monitors are listed in the [index](README.md).*

A reminder, not a detector. Microsoft Organizational Skilling (ESI, `esi.microsoft.com`) is not public: its page is a script shell (see [source-watch.md](source-watch.md)), so no script can tell whether ESI has training for an exam. What a script can know is which exam pages have no ESI card yet: the `Microsoft ESI` list of the Missing Resources Audit (`AGENTS.md > Missing Resources Audit`). Every other month the reminder turns that list into ONE issue, a checklist with the search address each exam would have on ESI, so a maintainer who can see ESI opens the addresses instead of building them. Not rendered on the site, not part of the build. It has no tracker and makes no commit: its state is the issue.

- **Workflow:** `.github/workflows/esi-check-reminder.yml` — runs at 09:20 UTC on the 1st of every second month (January, March, May, July, September, November; cron `20 9 1 */2 *`) + manual trigger with a `dry_run` checkbox; permissions `issues: write` and `contents: read`; runs queue and never cancel each other; 10 minute timeout. It never pushes, so it is not one of the "workflows that push to `main`". To change the rhythm, change the cron line (and the `cron` assertion in the test).
- **Steps:** `node scripts/audit-missing-resources.mjs` first (rebuilds the list from the pages in the runner, nothing is committed, so a list that went stale in the repository cannot send a wrong checklist), then `node scripts/esi-check-reminder.mjs`.
- **Script:** `scripts/esi-check-reminder.mjs` — Node, no dependencies; `node scripts/esi-check-reminder.mjs` prints the checklist and touches nothing without `CREATE_ISSUES=1`. It reuses `raiseIssue` and `closeOpenIssues` of `scripts/failure-issue.mjs`.
- **The issue:** title `ESI: check which exams have training`, label `enhancement`, no assignee. The body is a checklist, one line per exam (`- [ ] [AB-210](<ESI search address>) (BETA) · [page](<exam page on GitHub>)`; the badge only when the exam has one), then what to do. The address is `https://esi.microsoft.com/Search?q=<CODE>&avail=Available&learningoption=Advanced+Role+Based`, the one every ESI card on the exam pages uses.
- **Every run:**
  - The list has exams and no issue is open: the issue is created.
  - The list has exams and the issue is still open (the last round was not finished): the refreshed list is added as a comment, so a round that nobody did does not make a second issue.
  - The list is empty: an open issue is closed with a comment; no issue means nothing to do.
- **Failsafe:** the list is read from `src/data_files/missing-resources.json` (or `MISSING_FILE`). A file that cannot be read, is not JSON or has no `Microsoft ESI` list ends the run with an `::error` line and exit code 1; it is never read as an empty list, because a run that could not look must not close the issue. A close that fails is an error too.
- **Env:** `GH_TOKEN` (the job token), `CREATE_ISSUES` (the workflow sets it; without it nothing is created, commented or closed), `DRY_RUN=1` (the same, whatever `CREATE_ISSUES` says), `MISSING_FILE`, `TODAY` (YYYY-MM-DD), `REPORT_FILE` (the text of the issue is also written there), `GITHUB_REPOSITORY` (default `mscerts/hub`), `GITHUB_SERVER_URL`/`GITHUB_RUN_ID` (a link to the run), `GITHUB_STEP_SUMMARY`, `GH_CLI_SCRIPT` (tests only: a fake `gh`).
- **Tests:** `tests/scripts/esi-check-reminder.test.mjs`, fully offline (an in-memory `gh`, the command line in dry-run mode and with a list that cannot be read, the shape of the ESI address against the exam pages, the workflow's cron and step order). `tests/scripts/audit-exemptions.test.mjs` keeps every ESI exemption true.
- **Not in the Tests Review Reminder's table:** `MONITORS` in `scripts/tests-review-reminder.mjs` lists the monitors that must have raised a real alert to prove they work. This reminder raises its issue by construction, so it proves nothing and is left out on purpose; its test file is one of the monitor tests that reminder offers to remove.

## Trying it
```bash
node scripts/audit-missing-resources.mjs
DRY_RUN=1 REPORT_FILE=/tmp/esi.md node scripts/esi-check-reminder.mjs    # the issue it would raise
```
After the workflow is on `main`, "Run workflow" with `dry_run` ticked prints the same checklist in the job summary without touching an issue.

## Working the issue
1. Open each link on ESI and look at the results.
2. Training found: add the card to the Videos tab of the exam page, after the other Microsoft cards of that grid (`AGENTS.md > Components`): title `Microsoft Enterprise Skills Initiative Instructor-led course`, the link of the checklist, `target="_blank"`.
3. Nothing found: add the exam under `"Microsoft ESI"` in `scripts/lib/audit-exemptions.mjs` with the date of the check in the reason (an exam that is BETA or NEW can simply stay on the list and be looked at again at the next round).
4. Run `node scripts/audit-missing-resources.mjs`, commit the regenerated `src/data_files/missing-resources.json` with the page edits and tick the boxes. Close the issue when done; the next round raises a new one if exams are still listed, and the issue closes itself when none are.

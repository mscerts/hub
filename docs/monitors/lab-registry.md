# Lab Registry Monitor

*Runbook of the Lab Registry Monitor. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the other monitors are listed in the [index](README.md).*

Weekly sync of the lab registry: one file that lists **every Microsoft Learn hands-on page** (exercise, lab and simulation units, guided and challenge projects, demonstrations, units with a demo link, Applied Skills, docs tutorials and quickstarts) with **the exams each belongs to**, so that nothing is missed and the pages Learn publishes later are found. It does for the Learn hands-on pages what the [Applied Skills Monitor](applied-skills.md) does for Applied Skills. It reads learnsync's data (the cache of the Learn catalog, see [learn-research-caches.md](learn-research-caches.md)), compares the registry with the lab pages of the hub and keeps ONE running issue. Not rendered on the site, not part of the build. GitHub lab files (the Microsoft GitHub tab of the lab pages) are not in it; the [Lab Repo Check](lab-repo-check.md) watches their repositories.

- **Workflow:** `.github/workflows/lab-registry-monitor.yml` — Tuesday 10:10 UTC (after Monday's learnsync runs) + manual trigger with `force_baseline` and `max_page_reads`. The sync step opens or updates the issue itself BEFORE the registry is committed, so a failed issue step skips the commit and the next run derives the same list again; the commit retries its push three times. A run is never cancelled half way (a newer run waits). A failing sync raises one `bug` issue titled `Lab registry: the sync failed` (a comment per further failed run, closed by the next healthy run, through `scripts/failure-issue.mjs`).
- **Script:** `scripts/lab-registry-sync.mjs` — Node, no dependencies; the rules and the file format are in `scripts/lib/lab-registry.mjs`. `node scripts/lab-registry-sync.mjs --check` is the read-only form: nothing is written and no issue is touched, the report goes to `REPORT_FILE`. Tests, fully offline (learnsync data and the Learn course list from temp files, unit pages from a fake `fetch`, the issue from an in-memory `gh`), are in `tests/scripts/lab-registry.test.mjs`.
- **Registry:** `src/data_files/lab-registry.json` — `{ schemaVersion, lastSynced, reported, scanned, entries }`, one entry per line, sorted by key. Write it only through the script, or edit a decision by hand (below) and run the sync.
- **Config:** none. The decisions are in the entries.

## What counts as hands-on (the types)

Decided by the maintainer on 2026-10-21. Learn only.

| `why` | A page is it when |
|-------|-------------------|
| `exercise` | a unit title has the whole word "exercise", or the unit's **address** has it while the title does not (`…/3-exercise-create-virtual-machine` titled "Monitor VM host data"); a set-up unit ("Prepare for the exercises") is not |
| `lab`, `simulation` | a unit title starts with "Lab" or "Simulation" and a separator |
| `guided project`, `challenge project` | a whole module whose title or address says so (kind `module`; its units are not entries of their own); a module whose own title has the word "exercise" ("Guided exercise - …") is a `module` entry of type `exercise` the same way |
| `demonstration` | a unit title starts with "Demo" or "Demonstration", or its address starts with `demo-`; a video to watch, a procedure to follow or a click-through guide, all three are in |
| `demo link` | a unit whose **page** links a demo host: `mslearn.cloudguides.com` / `cloudguides.com` (CloudGuides, the "click through demo" and "interactive guide" units) or `app.highlights.guide` (Zarmada Highlights). Found only by reading the page, because the title says nothing |
| `applied skill` | `/credentials/applied-skills/<slug>`, taken from the Applied Skills Monitor's cache (`applied-skills-cache.json`: its `active` and `new`; a retiring skill leaves the universe) |
| `tutorial`, `quickstart` | a learn.microsoft.com docs page that `scripts/lib/course-handson.mjs` calls so (title or address segment), in a docs family the hub already links (the first two segments of every Learn docs link in `src/content/docs`) or that the course of an exam sends its learners to (the docs links of the last unit of the course's modules, learnsync's `module-links.json`), without the Microsoft Entra app gallery tutorials (`/entra/identity/saas-apps/`) and without landing pages (a title with "documentation", starting or ending with "overview", or with "overview and") |

**Not in the registry, by decision:** concept and reading modules, practical modules without an "Exercise" label (for example the "Online workshop" modules), numbered-step how-to docs, overview docs, learning paths, GitHub lab files. The SC-100 Case Studies tab (four interactive case-study modules) is a documented exception that lives on its lab page only. The cards of such pages that are on lab pages today are listed as **extras** in the report (information); whether they go is a decision for when the check is enforced.

A unit's key has no position number (`/training/modules/a/exercise-x`, Learn reshuffles `6-exercise-x`), so a moved unit is the same entry; the real address is kept in `path`.

## Entries

`{ key, kind, why, title, path, demo?, exams, skip?, state, firstSeen, goneSince?, note? }`

- `kind`: `unit`, `module` (guided and challenge projects), `docs`, `applied-skill`.
- `exams`: `{ "AZ-104": "course" }`; the value says how the link was made: `course` (the page is in a module of the exam's official course: exam → course → learning path → module, the same scope map as the course tools, mechanical), `page` (a lab page of the exam links the page, or the module it is in), `judged` (the agent's judgement pass) or `maintainer`.
- `skip`: exams whose lab page deliberately does not have the page. The sync never adds them again.
- `state`: `active` (has an exam), `new` (no exam yet: the work list), `no-exam` (decided: belongs to none), `excluded` (decided: not hands-on after all, for example a set-up unit or a page that only points to a GitHub lab), `retiring` (Learn no longer lists it; stays until no lab page links it).
- `note`: free text for a decision.
- `scanned`: `{ module: unitSig }` of the modules whose unit pages were read (below).
- `reported`: the fingerprint of what the running issue was last told, and the day.

## What it does

1. Reads learnsync's `learn-catalog.json`, `learn-content.json` and `docs-catalog.json` (from `LEARNSYNC_DIR`, a checkout, else from the raw files of `mscerts/learnsync` on GitHub), the course list of the Learn catalog API (`type=courses`, the only place that knows which modules a course holds), the hub's exam pages, lab pages and the Applied Skills cache.
2. Builds the universe from titles and addresses (no page is read for that) and maps pages to exams: official courses (`course`) and the lab pages that link them (`page`). Decisions already in the file are kept.
3. **Reads the unit pages** of the modules that are new or whose `unitSig` changed, to find demo links. Scope: the modules of the hub exams' courses, the modules the lab pages link and the modules with a unit entry (`SCAN_SCOPE=all` reads every module). At most `MAX_PAGE_READS` units a run (a module is never split), politely (350 ms apart, retries, a failure is never evidence: the module stays unscanned and is tried again). The first runs catch up module by module; a local run with a large `MAX_PAGE_READS` does it at once. The default scope turned out to be about 2,050 modules (about 14,000 unit pages, about 0.75 s each including the pause, so about 3 hours): the first seed on 2026-10-21 was run in chunks of 2,000 units, each writing the registry, so a crash loses at most one chunk. No separate automation looks for demo links: this step is the only one.
4. Checks the registry against the lab pages: a page tied to an exam whose lab page lacks it is **missing**; a Learn card on a lab page that no entry accounts for is an **extra**.
5. Writes the registry when something changed (a moved `lastSynced` alone never causes a commit) and keeps the issue.

## The running issue

One issue, `Lab registry: hands-on pages need attention` (label `enhancement`), created when something needs a person, commented when the list changed since the last report (the fingerprint is in `reported`), closed with a comment when nothing is left. Its tables (at most 60 rows each, the headings give the counts): pages a lab page lacks, hands-on pages without an exam (newest first), pages Learn stopped listing that a lab page still links.

## Working the list

1. **Pages without an exam** (`new`): decide which exams each belongs to, or that it belongs to none. Edit the entry: put the exams into `exams` with the origin `maintainer` (or `judged`), or set `"state": "no-exam"` / `"excluded"` with a `note`. Then add the card to the lab page of each exam (`AGENTS.md > Lab Page Workflow`, same layout rules) and run the sync again. A page that is in a module of an exam's official course already has that exam.
   Cards: two or more exercise units of one module that belong to the exam are linked as the module (a module link covers its units), a single unit or a docs tutorial or quickstart gets a card of its own with the Learn title (no `Exercise -`, `Quickstart:` or `Tutorial -` prefix; a generic unit title such as "Exercises" takes the module title). Compare the page with the study guide of the exam (`node scripts/course-source.mjs`, the exam's tasks), not with its title alone.
2. **A page a lab page lacks**: add the card in the right tab, or put the exam into the entry's `skip` when the page should not be there.
3. **A page Learn no longer lists**: remove or replace the card; the entry goes by itself once no lab page links it.
4. Never edit `reported` or `scanned` by hand.

## Failsafes (nothing is written, a failure issue instead)

- the catalog or the course list cannot be read, or lists fewer than `MIN_MODULES` (2000) modules / `MIN_COURSES` (50) courses;
- a hub exam page cannot be found (the folder layout changed);
- more than `MAX_GONE_PCT` (30) percent of the registry's pages vanish from the universe at once (the data changed shape). `force_baseline` accepts that;
- a corrupt registry.

Not a failure, a warning and a note in the report: the docs catalog cannot be read (tutorials and quickstarts stay as they are), the unit page reads stop because more than `MAX_PAGE_FAILURE_PCT` (25) percent failed (Learn unreachable or blocking), the learnsync catalog is more than 21 days old, modules still wait for their pages to be read.

## Running it locally

```bash
LEARNSYNC_DIR=../learnsync/data node scripts/lab-registry-sync.mjs --check        # read-only
MAX_PAGE_READS=20000 node scripts/lab-registry-sync.mjs                           # the seed: read every page of the default scope and write the registry
```

Without `CREATE_ISSUES=1` no issue is touched. Do not commit a registry from a run against stale learnsync data. All variables are listed in the script header.

## Known limits

- Demo links are only found in the scanned scope. A module outside the hub's courses and lab pages that has none of the other types is not read unless `SCAN_SCOPE=all`.
- A unit that moved to another module appears as one retiring and one new entry; the exams of the old one are not carried over automatically.
- The address-only exercise rule can include a page that only points to a GitHub lab (seen once: AI-300 "Deploy content safety controls in Azure"); mark such a page `excluded`.
- Applied Skills come from the Applied Skills Monitor's cache, not from a page check of their own; learnsync still lists retired skills.

## Seed of 2026-10-21 (what the first complete run found)

3,214 pages: 2,263 exercises (by title or address; one is a whole "Guided exercise" module), 12 labs, 6 simulations, 8 demonstrations, 13 units found only by their page's demo link, 37 guided and 26 challenge projects, 35 Applied Skills and 814 docs tutorials and quickstarts (460 tutorials, 354 quickstarts, in the 58 docs families the hub's own pages link). 898 have an exam (52 exams), 2,316 have none yet. 2,049 modules were read; 20 units link a demo host: 18 CloudGuides (SC-200, AZ-120, SC-300, SC-500) and 2 Highlights (the SC-200 exercise "Investigate an incident" and the Purview exercise "Investigate potential data theft using Insider Risk"). The check found 79 pages that official-course exams' lab pages lacked; 53 + 13 cards were added to 13 lab pages, and 26 pairs wait for a decision about GitHub copies of the same labs (AI-200 9, AB-730 3, AI-901 14: the page has the GitHub version, `AGENTS.md > Lab Page Workflow` says to link the Learn one only). The file is about 1.2 MB.

## Association pass of 2026-10-21

After the docs scope was widened to the families the exam courses link, the registry held 4,972 pages, 898 of them with an exam and 4,074 without (hands-on units, projects and docs tutorials and quickstarts). They were judged exam by exam against the study guide of each of the 52 exams that has a lab page (the exams without a lab page, such as AZ-204 and AZ-305, were not part of it): for each exam the pages that matched a task of the guide best were listed under that task (a lexical shortlist, tool and language variants of one docs page collapsed into one row), then picked by hand. The audience of the exam decided the variants: administrator exams take the portal, CLI, PowerShell, Bicep and ARM versions of a page, developer exams add the Python, C#, .NET and JavaScript versions, fundamentals exams only the portal version; Terraform, Ansible, Java and Go versions were left out everywhere. Pages of products the exam does not cover (Business Central and Project Operations for the Finance and Supply Chain exams, Fabric, Databricks and Synapse for most others, Power Platform modules for Dynamics exams) were left out even when a title matched.

Result: 922 pages were tied to one or more exams with the origin `judged` (1,502 exam links; the registry has 2,742 in all: 1,502 judged, 663 `page`, 577 `course`), 1,116 cards were added to the Microsoft Learn tab of 52 lab pages (79 of them to the six sub tabs of AZ-104, by the domain of the study guide task; the SC-100 tab that was a placeholder and the AZ-800 tab that only held a note were filled), and the 3,130 pages left over were set to `no-exam` with the note "judged 2026-10-21". Landing pages of docs families ("... documentation - Quickstarts, Tutorials, API Reference", "Deployment Overview") were taken out of the universe by a rule. Two Applied Skills have no exam (Configure and migrate to Azure Database for PostgreSQL, Get started with classes, properties, and methods in C#). The 26 pairs whose lab page had the GitHub version of the same lab (AI-200 9, AB-730 3, AI-901 14) were closed by linking the Learn exercise instead of the GitHub lab (the wrapper rule of `AGENTS.md > Lab Page Workflow`); AI-901 no longer has a Microsoft GitHub tab.

From here on only pages that appear later need a decision. A lab page created for another exam needs the same pass over the `no-exam` pages for that exam.

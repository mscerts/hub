# Course candidates: the shortlist for every task

*Runbook of the candidate generator (`scripts/course-candidates.mjs`, `scripts/lib/course-candidates.mjs`, `scripts/lib/course-lexical.mjs`, `scripts/lib/course-aliases.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). The inputs are described in [course-source.md](course-source.md); what a finished course looks like is in [courses.md](courses.md).*

For every task of an exam's study guide the generator produces a **shortlist** of Microsoft Learn modules, units and documentation pages that might cover it, each tagged with where it came from. It decides nothing. It is lexical (BM25 over titles, descriptions, unit titles and URL words), so it finds pages that share the words of a task and is noisy by nature; the **product constraint** and the **hard filters** take out what is plainly wrong, and the judging step (not built yet) decides what belongs in the course. Nothing is written to the repository: the output is a working file for the next step.

## No limit on how many

There is **no cap on the number of candidates** (maintainer's rule, 2026-10-19: if a resource is relevant it is included, there is no such thing as too many). The per-source limits (`DEFAULTS.limits`), the number of ranked pages a search examines (`scan`) and the floor relative to the best page's score (`relativeFloor`) are all off by default (`Infinity`, `Infinity`, `0`; written to the file's `params` as `null`, `null` and `0`). What still keeps a page out is relevance, not count: the **absolute coverage threshold** per provenance (`minCoverage`: the share of the task's own words a page must contain), the **hard filters** (retired, not in the caches, a page that is not a Learn page, boilerplate) and the **product constraint** below. A limit can still be passed as an option (`options.limits`, `options.scan`, `options.relativeFloor`) to look at a short list.

The price is judging work, not correctness: a shortlist several times longer means several times more prompts (see [course-judging.md](course-judging.md), which cuts a skill group into parts of at most 150 candidates so that each prompt fits one session). Measured on AZ-104 on 2026-10-19: with the old limits 1,496 candidates (143 of the 354 picks of the hand-made test page among them); with none 13,099 (215 of the 354), of which `P4` documentation pages are 10,382.

## Provenance

Every candidate has a `source`, the same four values as a course file's picks ([courses.md](courses.md)):

| Source | What it is | Pool searched |
|--------|------------|---------------|
| `P1` | A module or **unit** of the exam's own official course | The modules of the exam's courses (`buildScopeMap`), and their units (`unitUrls` give the real deep-link URLs) |
| `P2` | A documentation page one of those modules lists in its last unit | `module-links.json` of the exam's own modules; the module that lists it is `via` |
| `P3` | A module or unit of **another** exam's official course (AZ-700 for an AZ-104 networking task) | Every module some official course uses, minus the exam's own |
| `P4` | Anything else the catalogs have | Modules no official course uses; documentation pages no module of the exam lists (`docs-catalog.json`, Learn host only) |

A page found as `P2` is never offered again as `P4`. A unit candidate carries the module it belongs to. A task that has no `P1` module of its own is offered the modules that best fit its **skill group** (see below), marked `viaGroup`.

## The fundamentals of a skill group

Every skill group also gets a shortlist for its **fundamentals** (maintainer, 2026-10-21; [courses.md](courses.md)): the theory a learner needs before the group's tasks. It has two parts. **The word search** is the task search with the **group's title and the words of all its tasks** as one query and **looser coverage thresholds** (`FOUNDATION_DEFAULTS.minCoverage`: P1 0.15, P2 0.25, P3 0.25, P4 0.3 against 0.34, 0.5, 0.5, 0.6 for a task); the long query dilutes the coverage, which is what keeps it bounded (with the title alone and these thresholds one AZ-104 group got 1,684 candidates). It cannot find a concept page that shares no word with the group (SC-900's "Describe identity concepts" for "Manage Microsoft Entra users and groups"), so **the concept pass** adds the modules and documentation pages with a theory-like title (`CONCEPT_TITLE`: describe, understand, explore, introduction to, what is, concepts, overview, basics) that carry one of the specific products of the exam's own modules for the group (a product held by at most `genericProductShare` of all modules) or sit in the same documentation families; they are marked `concept: true` and the judge sees it. The same provenance and hard filters apply. Pages the course leaves to the lab page (hands-on: `course-handson.mjs`) are dropped and counted under `dropped["hands-on"]`. The candidates are in the file's `foundations` list, one entry per group with the key `<group>/@foundations`, `foundation: true` and the group's task wordings in `tasks`; nothing in them says whether a page is theory, the judge decides. `node scripts/course-candidates.mjs <CODE> --task "<group title>"` previews a group's fundamentals shortlist (no AI, nothing written), which is the cheap way to see how liberal it is before a judge reads it. `generateCandidates` takes `options.foundations: false` to leave them out (`--no-foundations` on the command line) or `options.foundations.minCoverage` to change the thresholds. The fundamentals of other exams' courses (AZ-900, SC-900) appear as `P3` when their modules share the group's words; whether that reaches the right pages on real data has not been measured yet.

## The product constraint

A task has an **anchor**: the best `P1` modules for it (at most 3, each covering at least half of the task and scoring at least half of the best), the products they carry and the documentation **families** their last units list. A family is the first two path segments of a Learn page (`/azure/virtual-network`, `/entra/id-governance`; three for `/cli/azure`, `/rest/api`, `/powershell/module`, `/azure/templates`, `/azure/developer`, which name the service one level deeper). Only families that hold at least 10% of the anchor's links count, so one licensing link in an identity module does not make `/microsoft-365/admin` part of the task. A link that more than 25 modules list is boilerplate (a community blog, `aka.ms/FindATrainer`) and counts for nothing.

What is kept out is decided at the level of the **exam**, what ranks first at the level of the task:

- **Out of scope (dropped, counted):** a documentation page whose family no module of the exam lists; a module whose documentation is mostly in families the exam does not list. This is what keeps SAP, Cosmos DB, SQL and Teams pages and the entitlement-management pages (identity governance, not an Azure administrator's job) out of an Azure identity task.
- **A module's families** are those of the documentation its last unit lists. A module with no links (every module no course uses, a quarter of the official ones) has them **inferred**: the families of the five documentation pages that best match its title (at least two must). Learn's product tags are only the last resort, when there is no documentation catalog or no page matches: they say far less ("Azure", a SharePoint module tagged `Virtual Machines`), and a module with only generic tags must cover 75% of the task.
- **A task with no good module of its own** (the official course skips it: resource locks, cost management, or covers only part of it, like AZ-104's external users) cannot say which family it belongs to. It is anchored on the whole exam (`anchor.basis: "exam"`), may use any family under the roots the exam touches (`/azure`, `/entra`), and `P3`/`P4` pages must cover at least 80% of the task. A family no module of the exam lists is **foreign** (`foreignFamily: true`): such a page scores 65% lower, so it only shows when nothing from the exam's own families does (cost management for AZ-104: yes; identity governance next to pages that really cover external users: no).
- **Sections:** a third path segment with at least five pages below it is a section of its family (`/entra/external-id/customers` beside the workforce pages of `/entra/external-id`). A documentation page in a section that no module of the exam lists scores 40% lower and is marked `siblingSection`.
- **Ranking signals:** with a strong anchor, a candidate inside the anchor's families (`anchored: true`) scores 25% higher; a `P2` page listed by an anchor module 20% higher; a module that one of the exam's modules recommends in its last unit ("Learn more with self-paced training") 30% higher, with `recommendedBy` naming it. These are signals, never filters.
- **The skill group as a fallback:** the official course is organised by skill group, and a task's own words may be in none of its titles ("Assign roles at different scopes" belongs to the module about role-based access control, which never says "assign" or "scopes"). A task with no `P1` module is offered up to three modules that cover half of its group's title, marked `viaGroup: true`. The task still says `noP1: true`: the shortlist knows the group, not the task.

## Hard filters

A page that fails one is counted per task (`dropped`, with up to three samples each), never listed:

| Reason | Meaning |
|--------|---------|
| `not-in-cache` | A documentation page that is not in `docs-urls.txt`, or a module the catalog does not have |
| `moved` | The path is the `from` of a `moved` or `retired` entry in `docs-redirects.json` |
| `removed` | A module in the catalog's tombstones |
| `not-english` | A locale in the path, or a title that is mostly not Latin script |
| `retired` | `/previous-versions/` or `/archive/` in the path, or `(retired)` / `[deprecated]` / `Retired:` in the title |
| `classic` | The title has the word "classic", or an address segment does (`create-classic-file-share`, `/classic/`): the old way of doing something, which a course does not teach (`scripts/lib/course-classic.mjs`) |
| `boilerplate` | A documentation page that more than 25 modules list |
| `out-of-scope-product` | The product constraint above |

## How a page is scored

- **Query:** the task's words, stemmed (route, routes, routing, routed are one term), stopwords and fluff ("different", "existing") removed. The guide's action verbs ("configure", "manage", "implement", ...) stay at a quarter of the weight, so "Configure user-defined routes" does not prefer a page for saying "configure". The skill group's title adds terms at 0.4 weight; they help rank vague tasks ("Configure access") and never count toward coverage.
- **Abbreviations:** `scripts/lib/course-aliases.mjs` lists about 45 abbreviations and their long forms (RBAC, VM, VNet, NSG, UDR, SSPR, MFA, PIM, ARM, AKS, DLP, TLS, `aad` and the Entra ID names, ...). A page or a task that says either form has the concept, so "RBAC" finds "role-based access control" and the other way round; a task's long form keeps its words as well, so a page with only some of them still counts for part of it. Add an entry only for a term that means one thing in Microsoft's documentation, and run the tests and one exam afterwards: it changes rankings everywhere.
- **Score:** BM25 over weighted fields (title 3, unit titles 1, products 0.5 for modules; title 3, description 1, URL words 1.5, the link texts of modules that list it 2 for documentation), plus a bonus for each pair of neighbouring task words that appear next to each other in the title.
- **Coverage:** the share of the task's own terms a page contains, each weighed by its rarity in that pool, so a page with the distinctive word covers more than one with only "users". A word no page has still counts against coverage (nothing covers the task), a verb can only add to it, and a page that shares only the verb or the group's words is not a hit. Per provenance a page needs `P1` 0.34, `P2` 0.5, `P3` 0.5, `P4` 0.6.
- **Cut:** the best N per provenance and kind (`P1` 5 modules and 6 units, `P2` 8, `P3` 4 modules and 4 units, `P4` 3 modules and 6 documentation pages), and nothing below 40% of the best in its group.
- **Relaxed pass:** a task that found nothing at all is searched once more with every coverage scaled by 0.6, and its candidates carry `relaxed: true` (long compound tasks like "Manage costs by using alerts, budgets, and Azure Advisor recommendations", where no page covers all of it).

Every number is an option (`DEFAULTS` in `scripts/lib/course-candidates.mjs`); the options in force are echoed in the output's `params`, and the output is deterministic (ties are broken by path).

## The output

`<CODE>.candidates.json`, plain data:

```json
{
  "schemaVersion": 1,
  "code": "AZ-104",
  "params": { "limits": {}, "minCoverage": {}, "...": "..." },
  "inputs": { "guideHash": "<hash>", "scopeFingerprint": "<40 hex>", "moduleLinksChecked": "...", "docsCatalog": true },
  "exam": { "products": [], "families": [], "sections": [] },
  "foundations": [ { "key": "domain/group/@foundations", "text": "<the group's title>", "foundation": true, "tasks": ["<task wording>"], "candidates": [] } ],
  "tasks": [
    { "key": "domain/group/task", "text": "Configure user-defined routes", "domain": "...", "group": "...",
      "query": [{ "word": "user", "weight": 1 }],
      "anchor": { "basis": "p1-top", "modules": [{ "path": "...", "title": "..." }], "products": [], "families": ["/azure/virtual-network"] },
      "noP1": false, "viaGroup": true, "relaxed": true,
      "candidates": [
        { "target": { "kind": "unit", "path": "/training/modules/x/5-unit" }, "title": "...", "source": "P1", "rank": 1,
          "score": 33.43, "coverage": 1, "matched": ["user defined routes"],
          "module": { "path": "/training/modules/x", "title": "..." }, "unitSig": "<sha1>", "courses": ["AZ-104T00"] },
        { "target": { "kind": "docs", "path": "/azure/virtual-network/y" }, "title": "...", "source": "P2", "rank": 1,
          "via": "/training/modules/x", "family": "/azure/virtual-network", "...": "..." }
      ],
      "dropped": { "out-of-scope-product": { "count": 28, "samples": [{ "path": "...", "score": 4.2 }] } } } ],
  "stats": { "tasks": 82, "tasksWithoutP1": 8, "tasksWithoutCandidates": 0, "candidates": 1496, "bySource": { "P1": 494, "P2": 197, "P3": 333, "P4": 472 } },
  "warnings": []
}
```

It follows the course file closely so the next step can copy fields: `target`, `title` and `source` are a pick's; `via` is a `P2` pick's; `unitSig` is what `inputs.picked` records for a `P3`/`P4` module ([courses.md](courses.md)). The signals for the judge, none stored in the course: `coverage` and `score`; `anchored`, `foreignFamily`, `siblingSection`, `recommendedBy`; `viaGroup` and `relaxed`. `noP1: true` is the explicit "the exam's own course has nothing for this task" state, whether or not the group's modules were offered. `inputs` says what the candidates were built from, so a stale file can be told from a current one.

## Running it

```bash
node scripts/course-candidates.mjs AZ-104 --task "user-defined routes"   # print the shortlist of the matching tasks
node scripts/course-candidates.mjs AZ-104 --task "external users" --json # the same as data
node scripts/course-candidates.mjs AZ-104 [--out DIR]                    # the whole exam into <tmp>/course-candidates/AZ-104.candidates.json
```

Inputs: the stored study guide (`src/data_files/learn-exams.json`, `LEARN_EXAMS_FILE`), learnsync data (a checkout in `LEARNSYNC_DIR`, else `../learnsync`, else GitHub `main`: `learn-catalog.json`, `learn-content.json`, `module-links.json`, and `docs-catalog.json` (about 40 MB), `docs-urls.txt`, `docs-redirects.json`), and the catalog API's course list (one request). A missing documentation file is a warning that switches the filters that need it off (no `docs-catalog.json`: only pages that modules list can be candidates, and a module's families cannot be inferred). A whole exam takes about ten seconds. Exit code 0 done, 2 usage or input error.

## Known limits

- **It is lexical, with two helps.** Abbreviations are handled (above), and a task the exam's own course cannot match is placed by its skill group. There is no general synonym handling: a task whose words differ from every title and whose group title does not fit either ("Manage subscriptions", "Manage costs by using alerts, budgets, and Azure Advisor recommendations" at AZ-104) gets `P3`/`P4` candidates only. A feedback step that learns the synonyms from the top documentation pages was considered and left out; if the judging step shows a recall problem, that is the next thing to try.
- **Unit-level resources are not harvested.** `P2` only knows the last unit of a module ([course-source.md](course-source.md)). Measured on 2026-10-17 on 20 lesson units of four AZ-104 modules: 11 inline documentation links, about half a link per unit, many of them repeating the last unit's. A harvest would be one request per unit (about 11,000 for the official courses, a new data model and a first pass of an hour or more in learnsync's workflow), so it is not worth building before the judging step shows that `P2` is short.
- **Families are two path segments, with sections** for the sub-areas that have enough pages. A sub-area with fewer than five pages is not told apart.
- **The alias list is curated by hand.** It holds what the author knew; a missing abbreviation behaves as before (its words match, the long form does not).
- **A spot check on 2026-10-17** (not an evaluation; the gold set is a pilot step): AZ-104 gave 82 tasks and 1,496 candidates (`P1` 494, `P2` 197, `P3` 333, `P4` 472) in about ten seconds. Eight tasks have no `P1` module of their own (the official course in the cache lacks resource locks, subscriptions, cost management, stored access policies, TLS for App Service, Bastion and Site Recovery, and says "RBAC" where the task says "roles"); six of them were offered the group's modules, so "Assign roles at different scopes" now lists the RBAC module. Four tasks needed the relaxed pass and none came back empty. For "Manage external users" the entitlement-management module, unit and pages stayed out, no SharePoint or sustainability module appeared, and SC-300's external identities module ranked first among the other exams' modules; for "Configure user-defined routes" the right module and the traffic routing page were on the list and no SAP, Cosmos DB, SQL or Teams page was. Some noise remains by nature of lexical search (a Cosmos DB monitoring module for backup alerts).

## Tests

`tests/scripts/course-lexical.test.mjs`, `course-candidates.test.mjs` and `course-candidates-cli.test.mjs`, offline. `tests/scripts/helpers/example-candidates.mjs` is an invented corner of Learn (an exam about routing and identities, a sibling exam's module, an identity governance module, SAP and Cosmos DB modules, a mislabelled module, and documentation pages that each trip one hard filter); nothing in it says what a real exam covers.

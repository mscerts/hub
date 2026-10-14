# Applied Skills Monitor

*Runbook of the Applied Skills Monitor. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the other monitors are listed in the [index](README.md).*

Weekly sync of a cache of every Microsoft Applied Skills credential, cross-referenced with the lab pages that link to it. Not rendered on the site, not part of the build.

- **Workflow:** `.github/workflows/applied-skills-monitor.yml` — runs Monday 06:30 UTC + manual trigger; the issue step runs BEFORE the cache commit (a failed issue step skips the commit, so the next run reports the same skills again) and the commit retries its push three times
- **Script:** `scripts/applied-skills-sync.mjs` — Node, no dependencies; run with `node scripts/applied-skills-sync.mjs`. Tests, fully offline, in `tests/scripts/applied-skills-sync.test.mjs`: the script runs from a scratch copy of itself next to a copy of `scripts/lib` (it finds the lab pages relative to its own location, so the test supplies its own lab page and cache), with `tests/fixtures/legacy-monitors/fake-fetch.mjs` preloaded through `node --import` because the skill pages are read from a fixed `learn.microsoft.com` address (an address without a route is a 404 that says so on stderr, so a run never leaves the machine); the helpers are in `tests/fixtures/legacy-monitors/harness.mjs`. The retries after an HTTP error (three attempts, 5 and 10 seconds apart) are not covered, because the pauses have no override.
- **Cache:** `src/data_files/applied-skills-cache.json` — `{ lastSynced, active: [...], new: [...], retiring: [...] }`
- **On new or retired skills:** opens a GitHub issue (`enhancement`, titled `Applied Skills Changes Detected — <run id>`) listing them with products / affected lab pages
- **On failure:** opens a GitHub issue (`bug`, titled `Applied Skills Monitor Failed — <run id>`: one per failing run, see `AGENTS.md > CI/CD`) — listing API down or reshaped, too many detail pages failing, corrupt cache
- **Env:** `LISTING_URL`, `BASELINE_FILE`, `REPORT_FILE`, `ERROR_FILE`, `GITHUB_OUTPUT`, `MIN_SKILLS` (10), `MAX_RETIRED_PCT` (50), `MAX_PAGE_FAILURE_PCT` (50) and `FETCH_DELAY_MS` (500); the script header lists the defaults. It writes the `GITHUB_OUTPUT` keys `changes_found`, `baseline_updated` and `extraction_failed`, in lower case. There is no `TODAY` override: `lastSynced` comes from the real clock, so the tests age the stored one and check that a quiet run leaves it alone.

## Data sources
1. **Listing:** `https://learn.microsoft.com/api/contentbrowser/search/credentials?locale=en-us&$filter=credential_types/any(t: t eq 'applied skills')&$top=100` — the JSON API behind `learn.microsoft.com/credentials/browse/?credential_types=applied%20skills`. Paged with `$skip`; `hidden: true` entries are ignored. Retired skills are silently dropped from this listing.
2. **Detail page** `https://learn.microsoft.com/credentials/applied-skills/<slug>/` for every skill (listed, cached, or linked from a lab page): the `<h1>` gives the name (leading `Microsoft Applied Skills:` stripped), the `Product` links in "At a glance" give the product names exactly as shown on the page (the listing's `display_products` adds parent products such as `Windows` that the page does not show, so it is only a fallback), and `<meta name="retirementDate">` / the `has been retired` warning box flag retirement. Retired pages usually keep returning HTTP 200 with a past `retirementDate` and no warning box.
3. **Lab pages:** every non-draft `src/content/docs/labs/**/*.mdx` (comments stripped) is scanned for `credentials/applied-skills/<slug>`; the `resources/study-guides/...` path is not a skill and is skipped.

## Entry shape
`{ name, url, products, labPages, retirementDate? }` — `url` is the repo-normalized form `https://learn.microsoft.com/credentials/applied-skills/<slug>/?WT.mc_id=studentamb_165290` (copy-paste ready for a `LinkCard`); `labPages` are collection IDs like `labs/azure/az-900`; `retirementDate` (`YYYY-MM-DD`) appears only when the page exposes one — a future date is an announced retirement of a still-active skill.

## Category rules (applied every run)
- Listed on Learn and not in the cache → `new` if no lab page links it, otherwise straight to `active`.
- `new` → `active` automatically once any lab page links it. To mark a skill as intentionally unmapped (no matching exam, e.g. the C# one), move its entry to `active` by hand; manual placement in `active` is preserved even with empty `labPages`.
- `active`/`new` → `retiring` when the skill disappears from the listing or its page reports retirement; a lab-page link to a slug that is not on Learn at all is also reported as `retiring`.
- `retiring` entries stay until no lab page links them, then they are dropped automatically. `retiring` → `active` if the skill is re-listed.
- The issue only reports skills that changed category *this run*; items already sitting in `new`/`retiring` are not re-reported.

## Failsafes (no cache write, failure issue instead)
- Listing fetch fails after 3 attempts, returns invalid JSON, or yields `< MIN_SKILLS` (10) visible skills
- More than `MAX_RETIRED_PCT` (50%) of previously known skills vanish in one run (listing API probably changed)
- More than `MAX_PAGE_FAILURE_PCT` (50%) of detail pages fail with non-404 errors (site blocking); individual failures fall back to cached/listing data with a warning
- Corrupt cache JSON

## Working the list
1. `new`: verify the skill on Microsoft Learn, decide which exam(s) it fits (use `products`), add a `LinkCard` to the Applied Skills tab of the matching lab page(s) following the `AGENTS.md > Lab Pages` conventions, or move the entry to `active` if it maps to no exam.
2. `retiring`: remove the `LinkCard` from every page in `labPages` (keep the commented-out tab placeholder if the tab becomes empty).
3. Re-run `node scripts/applied-skills-sync.mjs` and commit the regenerated JSON together with the page edits. The file is only rewritten when `active`/`new`/`retiring` actually change.

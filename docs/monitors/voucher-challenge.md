# Voucher Challenge Monitor

*Runbook of the Voucher Challenge Monitor. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the other monitors are listed in the [index](README.md).*

Weekly check for new Microsoft "voucher challenge" / sweepstakes pages — limited-time promotions (tied to events like Ignite, Build, or a product launch) that give away discounted or free certification exam vouchers. Not rendered on the site, not part of the build.

- **Workflow:** `.github/workflows/voucher-challenge-monitor.yml` — runs Monday 09:00 UTC + manual trigger; the issue step runs BEFORE the tracker commit (a failed issue step skips the commit, so the next run reports the same challenge again) and the commit retries its push three times
- **Script:** `scripts/voucher-challenge-sync.mjs` — Node, no dependencies; run with `node scripts/voucher-challenge-sync.mjs`. Tests, fully offline, in `tests/scripts/voucher-challenge-sync.test.mjs`: the real script runs in a child process against a local server that stands in for the TOC (`TOC_URL`), with the helpers of `tests/fixtures/legacy-monitors/harness.mjs`; they read back what the workflow would see (the `GITHUB_OUTPUT` keys, the report, the error file).
- **Tracker:** `src/data_files/voucher-challenges.json` — `{ lastSynced, challenges: [{ title, href, firstSeen }] }`, append-only (entries are never removed, since Microsoft appears to keep old campaign pages in the nav indefinitely rather than retiring them)
- **On a new challenge:** opens a GitHub issue (`enhancement`, titled `New Voucher Challenge Detected — <run id>`) naming the page(s) found
- **On failure:** opens a GitHub issue (`bug`, titled `Voucher Challenge Monitor Failed — <run id>`: one per failing run, see `AGENTS.md > CI/CD`) — TOC fetch failed, response shape changed, or too many previously-known entries vanished at once (likely a schema change, not real retirements)
- **Env:** `TOC_URL`, `BASELINE_FILE`, `REPORT_FILE`, `ERROR_FILE`, `GITHUB_OUTPUT`, `MIN_TOP_LEVEL_ITEMS` (15) and `MAX_DROP_PCT` (50); the script header lists the defaults. It writes the `GITHUB_OUTPUT` keys `changes_found`, `baseline_updated` and `extraction_failed`, in lower case. There is no `TODAY` override: `firstSeen` and `lastSynced` come from the real clock, so the tests age the stored `lastSynced` and check that a quiet run leaves it alone.

## How it works
These promotional pages have no dedicated API or feed. They show up as entries in the Microsoft Learn "Credentials support" left-nav tree (the sidebar on pages like `https://learn.microsoft.com/credentials/support/microsoft-ignite-challenge-official-rules`), alongside the site's permanent/evergreen help sections (exam accommodations, scheduling, renewal, etc.).

1. Fetch `https://learn.microsoft.com/en-us/credentials/toc.json` — the TOC backing that whole nav tree.
2. Filter the **top-level** items only (`toc_title` matching `/challenge|voucher|sweepstake/i`). Evergreen sections are always nested with children of their own unrelated topic (e.g. "Credentials help" contains "Vouchers and redeeming discounts"), while every genuine promotional page observed so far is itself a bare top-level node — either a flat leaf (e.g. "Microsoft Defender Skilling Challenge") or a top-level group whose children are exactly Official Rules/FAQ/How to redeem (e.g. "Microsoft Ignite Challenge Sweepstakes"). Matching top-level items by keyword has had zero observed false positives/negatives against the full current tree.
3. For a grouped item, resolve its "Official Rules" child's `href` as the canonical URL (falling back to the first child if no page is literally titled that); a flat leaf uses its own `href`.
4. Diff resolved hrefs against the tracker; anything not already known is reported as new.

## Working the list
1. Open the linked page and verify the details: discount amount, deadline, candidate limit, country exclusions, and the redemption code/process (also check its FAQ/"How to redeem" siblings if it has any).
2. Decide whether it's worth a voucher page per the `AGENTS.md > Voucher Pages` conventions — most of these fit the Beta voucher format or a plain `100%`/`50%`/`Special` category page depending on the offer.
3. If it's time-boxed to a specific already-past event, or duplicates an existing tracked offer, no page is needed — the entry stays in the tracker either way (it's a historical record, not a to-do list).

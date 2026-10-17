# Agent Instructions — Microsoft Certification Hub

> For AI coding agents working on this repository.
> Keep this file updated as the project evolves.

---

## Identity

You are working on **msfthub.com** — a community site providing free study-material collections for Microsoft certification exams. Be direct, efficient, and preserve the existing code style.

Maintainers plan work on a private task board. If `.tasks.local.json` exists in the repository root, follow the Task Board section below; otherwise ignore it.

---

## Task Board (private)

The board is a private GitHub Projects board. It is the source of truth for what to work on and for handoffs between sessions, agents, and people. Use it only through the helper, run from the repository root:

```bash
node scripts/tasks.mjs <command>
```

| Command | Purpose |
|---------|---------|
| `list` | Open items (`--all` includes Done, `--mine` shows only yours) |
| `show <ref>` | Title, status, priority, due date, owner, link, and the item's Log |
| `start <ref>` | Claim the item: sets you as assignee |
| `note <ref> "<text>"` | Append a timestamped line to the item's Log |
| `add "<title>" --body "<text>"` | Create a new item (default Status, or `--status`/`--priority`/`--due`) |
| `link <ref> <pr-url>` | Record the pull request on the item |
| `status <ref> "<option>"` / `priority <ref> "<P0\|P1\|P2>"` / `due <ref> "<date>"` | Set the item's category, urgency, or due date |
| `done <ref>` | Move the item to Done |
| `unclaim <ref>` | Release your claim: clears the assignee |
| `archive <ref>` | Archive the item (hides it from `list`) |

`<ref>` is the REF column from `list`. Run `node scripts/tasks.mjs help` for all options.

### Workflow

1. At the start of a session, run `list`. If the user named a task, `show` it and read its Log; otherwise ask which item to take instead of picking one yourself.
2. Before editing files for an item, run `start <ref>`. If it reports the item is claimed by someone else, stop and tell the user. If the item names a task prompt from `.github/prompts/`, follow that prompt.
3. Run `note` when you make a decision, hit a blocker, or end a session: what changed, what is left, and what the next agent needs to know. The Log is the only handoff between sessions and tools, so write it for a reader with no other context. If you can't finish it and won't be returning to it, also run `unclaim` so someone else can pick it up.
4. After opening a pull request, run `link <ref> <pr-url>` and `note` that it's ready for review. Run `done` only when the user confirms the work is finished.
5. If you notice something worth doing outside the current task, don't add it to the board immediately — see "Surfacing things you notice" below.

If a board command fails (not configured, authentication, missing option), stop and report the error. Don't edit `.tasks.local.json`, change `gh` authentication, or modify `scripts/tasks.mjs` to work around it.

### Surfacing things you notice

While working on anything else, if you find room for improvement or an issue unrelated to the task at hand, present it to the user before continuing — describe what you found and why it matters — instead of silently fixing it or filing it away.

- If the user approves or rejects it, that's the end of it either way. Don't create a board item.
- If the user ignores it (moves on without addressing it, changes topic, ends the session), gather as much context as you can — what you found, where, why it matters, and how you noticed it — and file it on the board yourself. See `.tasks.lifecycle.md` for which column and exact command to use.

### Column lifecycle and priority

Items follow an intended path as they go from idea to done, and once structured, each needs a priority (how urgent) alongside its column (what kind of work) — some moves need the user's confirmation first. This is documented in `.tasks.lifecycle.md` in the repository root — a local, gitignored file, not part of this public repository, since it names the board's private column structure and priority scheme. Read it before creating or moving any board item, or before setting a priority. If it doesn't exist on your machine, ask the user for the column names and rules instead of guessing. These rules describe normal operation — an explicit instruction from the user overrides any of them.

### Board content stays private

This repository is public. Never copy task titles, bodies, Log notes, plans, or refs/IDs into anything that reaches this repository or its GitHub pages: commit messages, branch names, pull request titles and descriptions, code comments, content pages, issues, or review comments. Describe public changes by what they do (for example, "Fix broken lab links on the SC-300 page"), not by the plan behind them. Links go one way: the board may point to public pull requests; public content never points to the board.

---

## Project Context

- **Repo:** https://github.com/mscerts/hub
- **Site:** https://msfthub.com
- **Stack:** Astro 7, native MDX content collections, Tailwind
- **Package manager:** pnpm (do not use npm or yarn)
- **Build:** `pnpm build` = Astro checks, static build, and Pagefind indexing with `astro build --force` → output in `dist/`
- **Preview:** `pnpm dev` for local development

---

## Directory Structure

```
src/
├── components/
│   ├── sections/              # Landing page sections (features, testimonials, navbar&footer, misc)
│   ├── docs/                 # Docs shell, navigation, templates, and MDX components
│   ├── ui/                   # Shared site UI
│   ├── WikiList.astro        # Auto-generates wiki cards by directory prefix
│   ├── LabList.astro         # Auto-generates lab index cards from labs/<area>/ pages
│   ├── VoucherList.astro     # Auto-generates voucher cards by voucherCategory frontmatter
│   └── PartnerBadge.astro
├── content/
│   ├── docs/
│   │   ├── aibusiness/       # AI Business exam pages (AB-*)
│   │   ├── azure/            # Azure exam pages (AZ-*, AI-*, DP-*)
│   │   ├── dynamics/         # Dynamics 365 exam pages (MB-*)
│   │   ├── github/           # GitHub exam pages (GH-*)
│   │   ├── microsoft365/     # M365 exam pages (MS-*, MD-*)
│   │   ├── power/            # Power Platform exam pages (PL-*)
│   │   ├── security/         # Security exam pages (SC-*)
│   │   ├── guide/            # Certification program guide (8 pages)
│   │   ├── prepare/          # How-to-prepare pages (5 pages)
│   │   ├── vouchers/         # Discounted exam voucher pages
│   │   ├── labs/             # Lab collections (per-exam lab pages, parallel to exam structure)
│   │   ├── labs.mdx          # Lab index page (uses LabList component)
│   └── blog/                 # Blog collection (authors, pubDate, cardImage, readTime, tags)
├── pages/certs/               # Canonical wiki index, docs renderer, and Markdown endpoint
├── data_files/
│   ├── applied-skills-cache.json # Generated by scripts/applied-skills-sync.mjs (see docs/monitors/applied-skills.md)
│   ├── constants.ts          # Site metadata (title, description, SEO, OG)
│   ├── faqs.json
│   ├── features.json
│   ├── lab-repos-ignore.json # Lab repositories kept despite a warning, each with a reason (see docs/monitors/lab-repo-check.md)
│   ├── lab-repos.json        # Written by scripts/lab-repos-check.mjs (see docs/monitors/lab-repo-check.md)
│   ├── learn-content-watch.json # Written by scripts/learn-content-watch.mjs (see docs/monitors/learn-content-watch.md)
│   ├── learn-exams.json      # Generated by scripts/new-exam-check.mjs (see docs/monitors/new-exam-monitor.md)
│   ├── link-failures.json    # Written by scripts/link-failures.mjs (see docs/monitors/link-checker.md)
│   ├── mega_link.ts
│   ├── missing-resources.json # Generated by scripts/audit-missing-resources.mjs (see Missing Resources Audit)
│   ├── retirement-schedule.json # Written by scripts/retiring-exam-check.mjs (see docs/monitors/beta-and-retiring-exams.md > Retiring exam tracker)
│   ├── skills-hub-posts.json # Generated by scripts/skills-hub-watch.mjs (see docs/monitors/skills-hub-watch.md)
│   ├── source-watch.json     # Generated by scripts/source-watch.mjs (see docs/monitors/source-watch.md)
│   ├── voucher-review.json   # Generated by scripts/voucher-review-check.mjs (see docs/monitors/voucher-review.md)
│   └── watched-sources.json  # The list scripts/source-watch.mjs watches, edited by hand (see docs/monitors/source-watch.md)
├── utils/voucher-fields.ts   # Schema of the optional voucher review fields (voucherEnds, reviewBy, linkedExam)
├── content.config.ts         # Content schemas (docs + blog collections)
astro.config.mjs              # Redirects and Astro integrations
scripts/
├── lib/                      # Shared plumbing of the monitor scripts: gh.mjs, actions.mjs, retry.mjs, areas.mjs, beta-note.mjs (see docs/monitors/README.md > Shared plumbing)
├── beta-note.mjs             # Prints the :::note timeline of a beta exam page (see Beta Exam Pages)
├── course-source.mjs         # Parses a study guide into domain / skill group / task and builds the exam scope map (see docs/course-source.md)
├── course-file.mjs           # Validates a course file (src/data_files/courses/<CODE>.json) and renders the course page (see docs/courses.md)
├── course-status.mjs         # The rebuild check: compares a course file with today's study guide and Learn and prints what to redo (see docs/courses.md)
└── *.mjs, *.sh               # One dependency-free script per monitor, plus new-exam.mjs and the audits
tests/
├── scripts/                  # Offline tests of the scripts, the workflows and the docs claims (pnpm test:scripts)
│   └── helpers/              # Shared test helpers (scratch git remote for the commit steps, workflow file reader)
└── fixtures/                 # Trimmed real pages, feeds and API answers that only the tests read
.github/
├── workflows/                # CI and the monitors' schedules (see CI/CD)
└── dependabot.yml            # Weekly update of the pinned GitHub Actions and the npm packages of the pnpm workspace
docs/
└── monitors/                 # Runbook of each monitor and an index (README.md); see the Monitors section
```

## Content Collections

### `docs` collection
Uses the local schema in `src/content.config.ts`, including:
```ts
voucherCategory: z.enum(["100%", "50%", "Special"]).optional()
voucherEnds: voucherDate.optional()  // last day of the offer, YYYY-MM-DD
reviewBy: voucherDate.optional()     // day to re-check the offer, YYYY-MM-DD
linkedExam: examCode.optional()      // exam code the offer is tied to, e.g. AB-650
```
`voucherCategory` is used by `VoucherList.astro` to auto-categorize voucher pages. `voucherEnds`, `reviewBy` and `linkedExam` are defined in `src/utils/voucher-fields.ts`, are read only by the Voucher Review Monitor (`docs/monitors/voucher-review.md`; nothing on the site renders them) and are all optional (see "Voucher Pages"). A date may be written bare (`2026-10-31`, which YAML turns into a Date at UTC midnight), as an unquoted midnight timestamp (`2026-10-31T00:00:00Z`, the very same Date) or quoted (`"2026-10-31"`); all of them come out as a Date. A quoted timestamp, an unquoted date with any other time of day, or a day that does not exist (`2026-02-31`) fails the build.

### `blog` collection
Schema: `title`, `description`, `authors` (array with name/image), `pubDate`, `updatedDate?`, `cardImage`, `cardImageAlt?`, `readTime`, `tags?`, `draft?`

---

## Conventions

### Exam Pages
- One MDX file per exam at `src/content/docs/<area>/<CODE>.mdx`
- Canonical routes are lowercase under `/certs/`: `/certs/azure/az-800/`, `/certs/power/pl-300/`
- Filenames are uppercase: `AZ-800.mdx`, `PL-300.mdx`
- `<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`
- Area mapping: `azure` = AZ-*, AI-*, DP-*; `aibusiness` = AB-*; `dynamics` = MB-*; `github` = GH-*; `microsoft365` = MS-* and MD-*; `power` = PL-*; `security` = SC-*.
- Astro collection IDs are lowercase regardless of filename case (`AZ-800.mdx` -> id `azure/az-800`), and the canonical renderer exposes them at `/certs/azure/az-800/`. Changing only a filename's case never changes its URL and needs no redirect. It does, however, poison Astro's incremental content-layer cache; `pnpm build` passes `--force` to clear that cache, which makes such renames safe.
- Frontmatter title is `<CODE> Study Materials`.
- Frontmatter description must use the exact template: `Collection of study materials for the certification exam <CODE>: <Exam Name>. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`
- Use the official exam name, not the certification name. Verify it against Microsoft Learn; these names often differ.
- Exam pages do not use `voucherCategory`.
- After creating a new exam page (or adding resource links to an existing one), run `node scripts/audit-missing-resources.mjs` and commit the regenerated `src/data_files/missing-resources.json` (see Missing Resources Audit).

### URL Formats (normalized — preserve these)
- **Exam (preferred when published):** `https://learn.microsoft.com/credentials/certifications/exams/<code>?WT.mc_id=studentamb_165290`
- Some beta/new exams use a certification slug instead of `/exams/<code>`; use Microsoft's verified current destination rather than forcing a URL pattern.
- **Study guide:** `https://learn.microsoft.com/credentials/certifications/resources/study-guides/<code>?WT.mc_id=studentamb_165290`
- **Practice assessment:** `https://learn.microsoft.com/credentials/certifications/exams/<code>/practice/assessment?assessment-type=practice&assessmentId=<ID>&WT.mc_id=studentamb_165290`
- **No `/en-us/`** locale segments. Keep `?WT.mc_id=studentamb_165290` tracking params.
- **MeasureUp links** keep `#u44` fragment (code **MSFTHUB**).
- **Training course:** `https://learn.microsoft.com/training/courses/<code>t00?WT.mc_id=studentamb_165290` only after verifying that the course exists.
- **Internal links:** canonical docs paths start with `/certs/`, use lowercase, and normally have a trailing slash, for example `/certs/labs/azure/az-800/`.
- Third-party links such as GitHub and YouTube do not receive Microsoft tracking parameters.
- Practice assessment IDs are exam-specific and have no reliable public registry; obtain and verify each ID from Microsoft Learn.

### Exam Page Anatomy (canonical structure)
1. Frontmatter: `title: "<CODE> Study Materials"`, `description`
2. Imports from `@components/docs`: `LinkCard`, `CardGrid`, `Card`, `Tabs`, `TabItem`, `Aside`
3. Optional status banner: `:::tip` for beta/resource scarcity (every beta exam page also gets a separate `:::note` box with the beta timeline, see "Beta Exam Pages" below); `:::caution` for retirement, replacement details, or an unconfirmed at-risk change
4. `<Card title="Get Started" icon="star">` -> Exam link, Study Guide link, optional Exam Labs/Case Studies link, and the matching How to Prepare LinkCard as the final resource
5. `<Tabs>` with `TabItem`s: Text, Videos, Tests, Paid, Misc
6. Closing `</Card>`, then bottom `<Card title="MeasureUp Practice Tests" icon="open-book">` block with `<Aside>` for MSFTHUB discount; if no products exist, use a tip stating that MeasureUp has not released material yet

Resource placement:
- **Text:** Official Learn courses/paths, documentation, and reputable written guides.
- **Videos:** Verified video courses, exam reviews, and directly relevant technical sessions.
- **Tests:** Free practice assessments and legitimate free tests. A BETA or newly launched exam whose own Learn practice assessment is not published yet opens its Tests tab with a `:::note` saying that Microsoft usually publishes it about 8 weeks after the exam leaves beta and reaches general availability (the Learn Content Watch uses the same rule of thumb; the wording is in the pages of AB-330, AB-650, GH-700 and AZ-401, and the NEW exams' variant leaves out "leaves beta and"). When the exam gets its own card, remove the note: `tests/scripts/practice-assessment-note.test.mjs` fails for a page that has both. An exam page that only links the predecessor's assessment (`AZ-400: Microsoft Learn Practice Assessment`) has no assessment of its own yet, so the note stays.
- **Paid:** Paid courses, assessments, and practice-test products.
- **Misc:** Repositories, tools, communities, reference implementations, and supporting standards. Microsoft Agent Academy (`https://microsoft.github.io/agent-academy/`) belongs here only on exam pages where Copilot Studio / Copilot-and-agent building or administration is a core, named topic (not an incidental mention, and not a different Copilot product like GitHub Copilot) — currently AB-410, AB-620, AB-650, AB-730, AB-900.
- Keep all five exam tabs, even if some are empty. Sparse beta pages are expected.
- If an announced official course is future-dated, include its verified availability date in the description.
- Retiring pages retain valid existing resources and link to the verified replacement exam.

### Beta Exam Pages (timeline note box at the top)
Every exam page that is in beta (`{ text: "BETA", variant: "tip" }` in `src/data_files/exam-status.mjs`, tracked in `beta-exams.json`) opens, above the Get Started card, with the usual `:::tip` beta/resource-scarcity banner followed by a SEPARATE `:::note` box with the beta timeline and **real dates**, so visitors know when the exam is expected to leave beta and when beta scores arrive. The timeline never goes inside the `:::tip`: the tip keeps its existing beta text unchanged, and the `:::note` is its own box right after it.

Facts (Microsoft's "About beta Certification exams" page, `https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290`, section "Beta exam scoring and results"; re-read it before relying on these numbers, they are Microsoft's to change):
- A beta exam goes live (leaves beta, becomes generally available) approximately 10-12 weeks after the beta period begins.
- Beta scores are released about 10 days after the exam goes live. Depending on when in the beta process a candidate took the exam, waiting for a score can take up to 14 weeks, and the whole process can vary.

What the `:::note` must contain:
1. The date the beta period began, the first day the beta exam could be scheduled, as given by the official beta announcement (the Microsoft Learn / Skills Hub blog post that the beta voucher page's "Read Official Announcement" button points to, or the exam's own Microsoft Learn page if it states it).
2. The go-live expectation, shown two ways so readers can see both what Microsoft said and how the estimate is worked out:
   - What Microsoft announced, when it announced something: the expected go-live date or month exactly as Microsoft wrote it (for example "general availability in October 2026"), linked to the announcement. Never make it more precise than Microsoft did. When no announcement exists yet, say so in one short sentence ("We have not found an official go-live announcement from Microsoft yet.", the `unannounced` state; in the first 7 days after the beta start the `pending` state says instead that the announcement is still due, see "Announcement states").
   - The calculation: beta start + 10 weeks to beta start + 12 weeks as two real dates, with the start date and the "10-12 weeks" stated in the sentence so the arithmetic is visible ("counting from July 28, 2026 ...").
   When the two disagree, keep both and say so; do not drop either one.
3. The expected score release as a real date range: about 10 days after the calculated go-live window (the 10-week date + 10 days to the 12-week date + 10 days). When Microsoft stated a different scoring timeline for that exam (for example "approximately eight weeks after the beta period concludes" on the GH-700 certification page), state it too, with the date range it implies (the calculated go-live window plus that period), and say that it differs from the usual timeline.
4. A plain statement that these are estimates that can shift (scores can take up to 14 weeks), and a link to the hub's `[Beta Exams](/certs/vouchers/betaexams/)` page for more information (internal link, no `target="_blank"`). When the Microsoft source is cited, link `https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290` (not the old `/certifications/beta-exams` path, which only redirects).

Rules:
- Never guess or back-calculate the beta start date. If you cannot verify it from an official Microsoft source, stop and ask the user for it instead of publishing a date.
- The state of the announcement is recorded per exam in `src/data_files/beta-exams.json`, in two fields that are optional in the file's schema but required for every exam that is BETA: `betaStart` (`"YYYY-MM-DD"`, the day the beta period began, from the official source or the maintainers, never guessed) and `announcement` (`"pending"`, `"unannounced"` or the https URL of the announcement, with the `?WT.mc_id=studentamb_165290` parameter like other Microsoft links). The variant of the note must match `announcement` (see "Announcement states" below).
- When the announcement appears: set `announcement` to its URL, rewrite the note as `announced` (the announced go-live date or month as Microsoft wrote it, plus the calculation), add the beta voucher page (`node scripts/new-beta-voucher.mjs`, the "Beta voucher format" under "Voucher Pages", with `voucherEnds` and `linkedExam`) and link it from the exam page. If 7 days pass without an announcement, switch `announcement` to `"unannounced"` and the note to that variant.
- `tests/scripts/beta-pages.test.mjs` keeps the pages and the tracker in step, so a wrong or stale note fails `pnpm test:scripts`: every BETA exam has its page, the standard `:::tip`, exactly one `:::note` right after it, a `beta-exams.json` entry with a valid `betaStart` and `announcement`, and a note that passes the checks of `scripts/lib/beta-note.mjs` for that entry's state; a BETA exam without an entry fails; an entry that is not flagged `flaggedGA` must belong to a BETA exam; a page that is not BETA carries neither the tip nor a beta note. `flaggedGA` itself is never a failure: the Beta Exam Monitor commits it on its own when Learn drops the "(beta)" marker, and an entry flagged while the badge, tip and note are still there is a normal state that the monitor's issue follows up (and, for the exam's beta voucher page, the Voucher Review Monitor's `exam-learn-ga` finding) (see "Working the list" under "Beta exam tracker" in `docs/monitors/beta-and-retiring-exams.md`).
- All dates in a note are produced by `node scripts/beta-note.mjs --code <CODE>`, which prints the note for the state recorded in `beta-exams.json`; never compute them by hand (for an `announced` note, `--expects "<Microsoft's go-live wording>"` adds the announced go-live wording, and `--help` lists the other options). Exam-specific statements Microsoft makes about scoring (like the "approximately eight weeks after the beta period concludes" sentence on the GH-700 certification page) are added by hand after the generated text; do the arithmetic for their dates with a script (for example `node -e` with `Date.UTC`), not in your head, and write dates the way the rest of the repo does (`October 30, 2026`).
- Keep the note true. When Microsoft extends the beta, update the dates. When Microsoft announces the exact go-live date, state the official date and drop the estimate it replaces (a month-only announcement stays next to the calculation). When the exam goes live, remove the `:::note` together with the beta `:::tip` as part of the "Working the list" steps under "Beta exam tracker" in `docs/monitors/beta-and-retiring-exams.md`.

Announcement states: the value of `announcement` decides which variant of the `:::note` the page shows. The `:::tip` is the standard beta text already used on beta pages and stays as it is in all three variants. The dates are a worked example for a made-up exam whose beta began March 1, 2027 (go-live May 10, 2027 to May 24, 2027, scores May 20, 2027 to June 3, 2027), and the announcement link of the `announced` variant is a placeholder, not real data.

`announced` (Microsoft published the Skills Hub / Learn announcement and `announcement` holds its URL; when the announcement names no go-live date or month, the note only links it):

```mdx
:::tip
This is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.

If you have any resources that you would like to recommend, please let us know and we will add them.
:::

:::note
The beta period began on March 1, 2027. Microsoft's [announcement](https://techcommunity.microsoft.com/blog/skills-hub-blog/example-announcement/1234567?WT.mc_id=studentamb_165290) expects general availability in May 2027. Microsoft also usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from March 1, 2027 this exam is expected to leave beta between May 10, 2027 and May 24, 2027. Beta scores are released about 10 days after that, so expect results between May 20, 2027 and June 3, 2027. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information.
:::
```

`pending` (the exam was just released in beta and Microsoft has not published the Skills Hub blog announcement yet; that post normally carries the 80% beta discount code for the first 300 candidates and should arrive within a few days; use this state for at most 7 days after the beta start):

```mdx
:::tip
This is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.

If you have any resources that you would like to recommend, please let us know and we will add them.
:::

:::note
The beta period began on March 1, 2027. Microsoft usually announces a new beta exam on the [Skills Hub blog](https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog?WT.mc_id=studentamb_165290) with an 80% discount code for the first 300 candidates. That announcement has not been published for this exam yet and should arrive within a few days, so check back before you pay full price. Microsoft usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from March 1, 2027 this exam is expected to leave beta between May 10, 2027 and May 24, 2027. Beta scores are released about 10 days after that, so expect results between May 20, 2027 and June 3, 2027. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information about the 80% discount and early access to codes.
:::
```

`unannounced` (more than 7 days after the beta start and still no announcement found: stop promising "within a few days"):

```mdx
:::tip
This is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.

If you have any resources that you would like to recommend, please let us know and we will add them.
:::

:::note
The beta period began on March 1, 2027. We have not found an official go-live announcement from Microsoft yet. Microsoft usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from March 1, 2027 this exam is expected to leave beta between May 10, 2027 and May 24, 2027. Beta scores are released about 10 days after that, so expect results between May 20, 2027 and June 3, 2027. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information.
:::
```

### How to Prepare LinkCard (all exam pages)
- Every exam page's "Get Started" card ends with a `LinkCard` to the matching `/certs/prepare/` guide: the last `LinkCard`-type resource (after Exam Labs/Exam Case Studies/GitHub Case Studies if present, otherwise right after Study Guide) and before any `RelatedCerts` component.
- Classification (verify against Microsoft Learn for any new exam before assuming):
  - **Fundamentals** -> `/certs/prepare/fundamentals/`: exam name contains "Fundamentals" (AI-901, AZ-900, DP-900, PL-900, SC-900), GitHub's "Foundations" tier (GH-900), and AB-900.
  - **Business** -> `/certs/prepare/business/`: AB-730, AB-731 (non-technical AI Business Professional/Leader tier) and GH-700 (GitHub's non-technical Agentic AI Business Professional tier for product managers, program managers and business analysts; Learn tags its certification "Fundamentals", so this is a judgement call, re-check it when Microsoft publishes more about the exam).
  - **Role-based** -> `/certs/prepare/role-based/`: everything else (Associate/Expert/Specialty, all areas) — one page covers all three tiers.
- Wording:
  - Fundamentals: `title="How to Prepare for Fundamentals Exams" href="/certs/prepare/fundamentals/" description="Guidance on study time, resources, and readiness for Microsoft Fundamentals exams."`
  - Business: `title="How to Prepare for Business Exams" href="/certs/prepare/business/" description="Guidance on study time, resources, and readiness for Microsoft Business exams."`
  - Role-based: `title="How to Prepare for Role-Based Exams" href="/certs/prepare/role-based/" description="Guidance on hands-on practice, documentation, and readiness for Microsoft role-based exams."`
- No `target="_blank"` (internal link). Add this LinkCard, with the correct classification, to any new exam page.

### At Risk Exam Treatment (unconfirmed change — distinct from Retiring)
- Use when Microsoft signals a *possible* future change (a new exam, a level change, an objective-domain/blueprint survey) but nothing is confirmed — do not use RETIRING language or badges for these.
- Add a `:::caution` banner at the top citing the concrete evidence (announcement post, survey, etc.) with a source link. Keep it terse and structurally consistent: new exam code + title (if known), "may replace X", "could mean retirement", "neither confirmed", one source link.
- Sidebar badge: `{ text: "AT RISK", variant: "caution" }` in `src/data_files/exam-status.mjs`, keyed by area then exam code.
- Example: AZ-400 carried this treatment while AZ-401: Designing and Implementing Microsoft Agentic DevOps was only a blueprint survey. On 2026-10-14 Microsoft Learn listed AZ-401 as a beta exam of its own certification (Microsoft Certified: Agentic DevOps Engineer Expert (beta)); the `:::caution` was briefly turned into a factual `:::note` and the badge removed, and the same day the maintainers reinstated both. The banner then said that AZ-401 is listed on Learn, that it may replace AZ-400 (unconfirmed), that the AZ-400 Learn page shows no retirement date, and it quoted the footnote at the bottom of that page ("** Complete this exam before the retirement date to ensure it is applied toward your certification. After the retirement date, please refer to the related certification for exam requirements."). Checked 2026-10-14: Learn shows that same footnote on other exam pages too (AB-650, AZ-401, AZ-802, AZ-305, MS-102, AZ-800) and not on others (AZ-104, AZ-900, SC-200, PL-300, DP-420, MD-102), so it is not evidence of a retirement by itself: quote it only together with that caveat. **Resolved 2026-10-15:** Microsoft's Skills Hub announcement of Exam AZ-401 (beta) says that, with that release, Exam AZ-400 and Microsoft Certified: DevOps Engineer Expert retire on February 1, 2027. AZ-400 therefore moved to the retirement rules: `RETIRING` badge, a `:::caution` linking the announcement, and an entry in `retiring-exams.json` with `replacementCode` AZ-401 (Learn's retirement tables did not list AZ-400 yet that day).
- Resolve the treatment when Microsoft settles the question: keep the badge only while a replacement or level change is announced without a date (or the maintainers see credible signs of one, as with AZ-400 on 2026-10-14), and switch to the retirement rules (`:::caution` with the verified replacement, `RETIRING` badge, then `RETIRED` once the date has passed, `retiring-exams.json`) as soon as an official date exists. If the new exam is published and nothing is announced about the old one and the maintainers see no sign of a change, state only the verified facts and drop the badge.
- Keep all existing resources intact; this is an informational heads-up, not a retirement.

### Lab Pages
- Files are lowercase at `src/content/docs/labs/<area>/<code>.mdx`; routes are `/certs/labs/<area>/<code>/`.
- Required title: `<CODE> Labs`. When a description is present, use the verified exam name, for example: `Lab exercises for <CODE>: <Exam Name>. Includes Microsoft Learn and Microsoft GitHub labs.`
- No blank line before the closing frontmatter fence, between frontmatter and imports, or between `<Tabs>` and the first `<TabItem>`.
- Import only used docs components from `@components/docs`. Common imports are `LinkCard`, `CardGrid`, `Card`, `Tabs`, and `TabItem`.
- Canonical tab order: Applied Skills, Microsoft Learn, Microsoft GitHub. Guided Labs was removed and must not be reintroduced. The only exception is SC-100, whose lab page starts with an extra Case Studies tab (see below).
- Always preserve a commented-out tab placeholder when a category has no real resources; do not use an active empty tab or blank active `LinkCard` placeholder.
- Design/architect-tier exams whose only real hands-on resource is a case-study collection (not sandboxed exercises) should not get a lab page at all — link only the case-study collection from the exam page's Get Started card, no `Exam Labs` LinkCard. Confirmed: AZ-305 (case studies at `microsoftlearning.github.io/AZ-305-DesigningMicrosoftAzureInfrastructureSolutions`) and AB-100 (Agentic AI Business Solutions Architect — no case-study collection exists yet either, just conceptual course content) — both had lab pages removed for this reason. Check for an existing "Exam/GitHub Case Studies" LinkCard, or confirm no genuine hands-on content exists, before creating a lab page for any new design/architect-tier exam.
- **Exception to the rule above, not common: SC-100.** It has a lab page (`labs/security/sc-100.mdx`, linked from the exam page with a `Labs and Case Studies` card) because a genuine instructor-led lab repo exists, `MicrosoftLearning/SC-100-Microsoft-Cybersecurity-Architect` (12 labs in `Instructions/Labs`, not archived), which is real hands-on content and not a case-study collection. The former case-study repo `github.com/Azure/AzureArchitectureExampleScenarios` returns 404 with no verified successor. SC-100 is an architect-level exam: knowing architecture is what the exam tests, and labs are optional support for preparation, so the page opens with a note saying that (above the tabs) and its first tab, **Case Studies** (an exception to the tab order above, for SC-100 only), links the four interactive case-study modules of the SC-100T00 course on Microsoft Learn (`case-study-identity-data-security`, `case-study-access-control-threat-resilience`, `case-study-endpoints-infrastructure`, `case-study-apps-data`; picked by the maintainers, all answer 200 and are updated in 2026, checked 2026-10-15). They replace the 16 case studies of the course repo's GitHub Pages site (`microsoftlearning.github.io/SC-100-Microsoft-Cybersecurity-Architect/Instructions/CaseStudyv2/`), which are a frozen May 2023 build: the site was last built on 2023-07-12 even though the repo has had pushes since, and `Instructions/` in the repo now holds only `Labs`, so those pages are not maintained and disappear if Pages is rebuilt. The same frozen build is why the labs answer 404 on `microsoftlearning.github.io`; the page therefore links the lab Markdown files on `github.com/MicrosoftLearning/SC-100-Microsoft-Cybersecurity-Architect/blob/master/Instructions/Labs/` (HTTP 200, the same pattern as MB-230 and MS-102). Switch the lab cards to `microsoftlearning.github.io/SC-100-Microsoft-Cybersecurity-Architect/Instructions/Labs/<file>.html` only once those addresses answer 200. That card is the one place a lab page link is not titled `Exam Labs` (every other exam page uses `Exam Labs`); the Missing Resources Audit accepts both titles. The SC-100T00 modules have no Learn exercise units (knowledge units and interactive case studies only, and the case studies are on the Case Studies tab), so the Microsoft Learn tab is a commented-out placeholder. Do not treat this as a precedent: every other design/architect-tier exam still needs a genuine lab repo or exercises before it gets a lab page.
- Indent using two-space nesting: outer `<Tabs>` at column 0; `<TabItem>` and `<CardGrid>` at 2 spaces; `<LinkCard>` at 4 spaces. Add 2 spaces per nested Tabs level.
- Docs directives (`:::note`, `:::tip`, `:::caution`) remain flush at column 0 even inside tabs.
- Strip trailing whitespace. Historical pages are not fully uniform, so normalize touched blocks only unless broad cleanup is requested.
- Preserve the known SC-900 setup `LinkCard` outside its `CardGrid`; it is an intentional out-of-scope legacy exception.
- Known verified resources: AZ-120 has three Learn exercises from `explore-azure-center-sap-solutions`; AZ-900 uses `MicrosoftLearning/AZ-900-Microsoft-Azure-Fundamentals`; SC-401 already includes `MicrosoftLearning/SC-401T00-Information-Security-Administrator`; the Azure Monitor Lab (Learn labs index) is a good cross-fit for monitoring-heavy Azure exams and is already used on AZ-104, AZ-204, AZ-700, and AZ-801. Do not duplicate them.
- More known verified GitHub repos (all under `MicrosoftLearning`, GitHub Pages exercise index at `microsoftlearning.github.io/<repo>/`): AI-901 uses `mslearn-ai-fundamentals` (current successor to the archived `AI-900-AIFundamentals`); AI-200 uses `mslearn-azure-ai`; AI-500 uses `mslearn-ai-multi-agents`; SC-500 uses `mslearn-sec-identity`; AB-900 uses `Administer-and-Secure-agents-with-Microsoft-Agent-365`; AZ-802 uses `AZ-802-Windows-Server-Administrator-Associate` (8 labs, no `LAB_AK_` answer-key variants yet) and no longer carries the AZ-800/AZ-801 repo labs (removed 2026-10-15 at the maintainers' request: both courses retired on 2026-09-30 and those repos' READMEs say the repos will be removed; the labs stay on the AZ-800 and AZ-801 lab pages while the repos exist, with both repos in `lab-repos-ignore.json` for their README's retirement notice). **When MicrosoftLearning archives or removes the AZ-800 or AZ-801 repo** (the Lab Repo Check then reports it as `archived` or `gone`), point that page's lab cards at the maintainer's fork instead of removing them: `github.com/teriaavibes/AZ-800-Administering-Windows-Server-Hybrid-Core-Infrastructure` and `github.com/teriaavibes/AZ-801-Configuring-Windows-Server-Hybrid-Advanced-Services` (snapshots from 2026-09-25 and 2026-09-30; default branch `master`; all 20 AZ-800 and 14 AZ-801 linked lab files exist there as `.md`, checked 2026-10-15). The forks have no GitHub Pages site, so link the Markdown files, `https://github.com/teriaavibes/<repo>/blob/master/Instructions/Labs/<file>.md` (the `.html` of the old `microsoftlearning.github.io` links becomes `.md`; keep the `%20` in the two names that have a space), the same pattern as SC-100, MB-230 and MS-102. The maintainer keeps the forks archived with a sync, so the Lab Repo Check will report each fork as `archived`: add it to `lab-repos-ignore.json` then, with that reason, and drop the old MicrosoftLearning entry. — the AZ-802T00 Learn paths are knowledge-based apart from the Azure Monitor VM exercise. When a repo has been superseded (older repo's README says "please use \<new-repo\>"), always use the new one. GitHub's own certifications (GH-*) do not have dedicated GitHub-org lab repos — their official prep path is Microsoft Learn only (per `resources.github.com/learn/certifications/`); do not invent one. GitHub-tagged Applied Skills do exist, though (product `GitHub` in the Applied Skills cache — currently the GitHub Copilot ones, GitHub Actions load testing, and GitHub secret scanning), and they belong on the matching GH-* lab page's Applied Skills tab (GH-200, GH-300, GH-500) as well as on AZ-400 where the study guide covers the same topic. Microsoft occasionally renames a skill without changing its slug (e.g. "Accelerate app development…" → "Accelerate AI-assisted development by using GitHub Copilot"); when the cache's `name` differs from a LinkCard title, update the title and keep the href.
- When searching GitHub for a course's lab repo, `github.com/search?q=...` rate-limits quickly (HTTP 429); prefer `github.com/orgs/MicrosoftLearning/repositories?q=<term>` instead, which is not rate-limited and searches the same repo set by keyword.
- Old claims that AZ-140, MD-102, MS-102, MS-700, or SC-900 have zero Learn exercises are unverified and must not be relied on.

### Lab Page Workflow
- Start from the nearest existing lab page for the same exam family or area, then match its structure instead of inventing a new layout.
- Create or edit lab pages to stay consistent with the canonical lab format used across the repo: frontmatter, imports, optional note, then `<Tabs>` with the established tab order.
- Keep descriptions aligned to the verified exam name and the exam-focused wording used elsewhere in the repository.
- Add only resources that are verified on Microsoft Learn or Microsoft-owned GitHub pages; do not infer labs, courses, or workshop titles from URL patterns alone.
- When a Microsoft Learn module/exercise is itself just a wrapper around a specific GitHub repo (the Learn page's setup/instructions point to and are based on that same repo), link the Learn version only, not the GitHub repo directly — don't list the same lab twice across the Microsoft Learn and Microsoft GitHub tabs. Only add a separate Microsoft GitHub entry when the repo is a genuinely distinct resource (no matching Learn wrapper exists for it).
- When a tab has no real content, comment out the entire tab block if the surrounding pages use that pattern; do not leave an active empty tab or an empty `CardGrid` unless the page already uses that convention and the task explicitly requires preserving it.
- Keep notes short and functional. Use `:::note` for availability or context, `:::tip` for light guidance, and `:::caution` for retirements, gaps, or replacement exams.
- Preserve existing links and wording when normalizing formatting. Make focused edits only in the touched block rather than reformatting the whole page.
- After creating or materially changing a lab page, link it from the matching exam page with an `Exam Labs` card only when the lab page actually exists. The lab index (`src/content/docs/labs.mdx`) is auto-generated by `LabList.astro` from `labs/<area>/<code>.mdx` files (card title `<CODE>: <Exam Name>` is derived from the lab description), so it needs no manual entry.
- For the Applied Skills tab, start from `src/data_files/applied-skills-cache.json` (see `docs/monitors/applied-skills.md`): `new` lists skills not yet linked from any lab page together with their products (to match them to exams), `active` shows where each skill is already linked, and anything in `retiring` must be removed from the lab pages it lists. Re-run `node scripts/applied-skills-sync.mjs` after editing Applied Skills links so `labPages` stays current.
- Validate every lab-page edit with `pnpm build` before finishing.

To discover genuine Microsoft Learn exercise units:
1. Fetch `https://learn.microsoft.com/training/courses/<code>t00` and read its `learn_item` learning-path UIDs.
2. Query `https://learn.microsoft.com/api/catalog/?uid=<comma-separated-path-uids>` to obtain each learning path's module UIDs.
3. Resolve each module's ordered `units` from the catalog.
4. Test each unit against the hands-on syntax below. Do not infer exercises from URL slugs; some exercise slugs do not contain the word "exercise".
5. Build the unit URL as `<module-base-url>/<1-based-unit-position>-<unit-slug>/?WT.mc_id=studentamb_165290`, remove `/en-us/`, and use the catalog's unit title as display text. **Caveat**: the catalog's `units` array position does not always match the real live-page URL number — some modules have hidden/non-sequential units in their live nav (numbering can skip a value, e.g. 1,2,3,5,6,7,8,9) that the catalog silently compresses into a gapless array, shifting every position from the gap onward. When adding a brand-new reference or resolving any doubt/conflict, cross-check by fetching the module's own index page (`https://learn.microsoft.com/training/modules/<slug>/`) — its nav list shows the real numbered slugs directly — rather than trusting the catalog's bare position number alone.

**Hands-on unit/module syntax** (verified 2026-08-29 against all ~27,000 cached unit titles — see `data/learn-catalog.json` in [mscerts/learnsync](https://github.com/mscerts/learnsync)):
- Primary signal: `unit.title` contains the whole word `Exercise` **anywhere** (case-insensitive), not just as a prefix — real titles include `Exercise - X`, `Exercise – X` (en dash), `Optional exercise - X`, `Hands-on exercise - X`, and suffix forms like `X exercise`/`X Exercise`. A prefix-only check misses ~3% of genuine exercises.
- Secondary signal: `unit.title` **starts with** `Lab` or `Simulation` followed by a separator (space, colon, or dash/en dash/em dash), e.g. `Lab - Configure...`, `Simulation - Create...`. Do not match these words anywhere in the title (bare "lab"/"simulation" appear often in non-hands-on reading content, e.g. "Understand DLP...simulation mode").
- Module-level override: if the **module's own title** starts with `Guided Project` or `Challenge Project`/`Challenge project` (any dash variant), treat every unit in that module as hands-on — these are whole modules structured as a single guided build, not individual "Exercise"-titled steps.
- Rejected as too noisy after sampling (majority of hits were unrelated reading content, not hands-on): bare `Practice` (almost always "best practices"), bare `Challenge` outside the module-title override (mostly topical "challenges" discussions), `Sandbox`, `Workshop` as a unit-level signal (an "Online workshop" *module* is just a title label — its own units still use the normal `Exercise -` pattern, so no extra rule is needed).
- Fallback for the rare unit whose title didn't resolve in the catalog (falls back to its raw uid in the cache): check whether the uid contains `.exercise-`.
- **Applied Skills are a separate content type**, not part of this modules/units catalog at all — they live under `https://learn.microsoft.com/credentials/applied-skills/<slug>` (a distinct URL namespace, inherently hands-on by definition, no title-pattern matching needed). Don't expect to find them in `learn-catalog.json`; discover and verify them the normal way (search Microsoft Learn directly) for the Applied Skills tab.

### Voucher Pages
- Files are lowercase slugs at `src/content/docs/vouchers/<slug>.mdx`; routes are `/certs/vouchers/<slug>/`.
- Frontmatter requires `title`, `description`, and `voucherCategory`, with category exactly `"100%"`, `"50%"`, or `"Special"`.
- `VoucherList.astro` automatically includes categorized pages on the voucher index, sorted by title. The sidebar remains hand-maintained.
- Common content uses `LinkButton`, `Steps`, `CardGrid`, and docs directives. Use notes for the core offer, cautions/dangers for restrictions, and clear CTA buttons.
- Voucher sidebar badges show the discount. An asterisk (for example, `*80%`) indicates limited availability or conditions.
- Optional review fields (frontmatter, all optional; see `docs/monitors/voucher-review.md`). They are for offers that are temporary by design (a campaign, an event, a beta window, a limited number of vouchers), not for stable offers:
  - `voucherEnds: YYYY-MM-DD`: the last day of the offer, only when the official source states it. Never guess it; a date derived from an event schedule or a lucky-draw cutoff is not the end of the offer.
  - `reviewBy: YYYY-MM-DD`: the day to look at the page again, for a temporary offer without a stated end date ("while stocks last", an event series) or whose details are still to be published.
  - `linkedExam: XX-123`: for an offer tied to a beta or upcoming exam, so the review notices when that exam leaves beta (the hub's `BETA`/`UPCOMING` status in `src/data_files/exam-status.mjs`) or is retiring or retired.
  - A stable (evergreen) offer, a standing programme such as the student discount, a partner programme or purchasable voucher bundles, carries none of these fields and is not reviewed. Never add a `reviewBy` to such a page to keep the monitor quiet: nothing lists pages without a date. When Microsoft announces that a stable offer is ending, add `voucherEnds` then.
- Ended offers. Only two conventions exist in the git history; use one of them:
  - Keep the page as a record (`levelup`, commit `36e2c83d`): remove `voucherCategory` (this is what takes the page off the voucher index, `VoucherList.astro` and the landing-page list), append `(Expired)` to the `title`, replace the availability note with a `:::caution` saying the offer is no longer active, and remove the entry from `voucherItems` in `src/data_files/docs-sidebar.ts`.
  - Delete the page (`fabricdatadays` in `12b11a4d`, `ab650beta` in `5a447884`, `ai500beta` in `39dcb9d2`, and many more): delete the `.mdx`, remove its `voucherItems` entry, convert every remaining link to it (exam pages, `src/content/blog/`) to plain text or remove it (see `docs/monitors/link-checker.md`), and when other sites may link to it add `"/vouchers/<slug>/": "/certs/vouchers/"` to `redirects` in `astro.config.mjs` (done for `fabricdatadays`, `defendersweepstakes`, `aichallenge`, `microsoftignite`; `public/_redirects` still carries the last two as well).
- Paused offers. When Microsoft stops an offer without saying whether it is over for good (the Virtual Training Days events, 2026-10-14), do not call it expired: keep the page with its title, remove `voucherCategory` and the `voucherItems` entry exactly as for an ended offer (that hides it from the voucher index, the landing-page list, the sidebar and the Voucher Review Monitor), and put a `:::caution` at the top of the page saying that nothing new is currently planned and that the page will be updated if the offer returns. When it returns, restore `voucherCategory` and the sidebar entry and remove the banner.
- A page without `voucherCategory` is not on any voucher list and is not reviewed.

Beta voucher format (the one layout of every beta voucher page; write it with `node scripts/new-beta-voucher.mjs`, which also prints the follow-up edits, `node scripts/new-beta-voucher.mjs` without arguments shows the options; the layout is defined once in `scripts/lib/beta-voucher.mjs` and `tests/scripts/beta-vouchers.test.mjs` fails when a page does not follow it, is not named `<code>beta.mdx`, or lacks its card on the exam page or its entry in `voucherItems`):
1. Frontmatter: title `Exam <CODE> (beta)` (the `(beta)` is what the Voucher Review Monitor uses to recognise a beta voucher page, `docs/monitors/voucher-review.md`), a quoted description `"Get 80% off the new Exam <CODE> (beta) for <certification>."` (a colon in an unquoted description breaks the page), `voucherCategory: "Special"`, `voucherEnds` (the last day of the registration/discount window stated in the official announcement) and `linkedExam` (the exam code), so the Voucher Review Monitor reminds you to retire the page when the window has passed or the exam leaves beta.
2. Import `LinkButton`, `LinkCard` and `Steps` from `@components/docs`.
3. A `:::tip` on top about the second, more private 80% beta code for another 300 people that the SME mailing list and LinkedIn group share (they last longer because they are not public), linking both and the Beta Exams page (`/certs/vouchers/betaexams/`) for how to get access.
4. Primary `Read Official Announcement` button to the Skills Hub post (tracking parameter, no `/en-us/`).
5. `:::note` with the candidate limit, the deadline and the code: "The first 300 people who take Exam <CODE> (beta) on or before <Month D, YYYY>, can get 80% off market price using code **<CODE>**."
6. An intro with the full exam title, the certification and what the exam validates (from the announcement): "Exam <CODE>: <exam name> is the new beta exam for <certification>. <what it validates, who it is for>"
7. `## How to claim the 80% discount` with three steps: register (the Learn exam or certification page), schedule on or before the deadline, use the code at payment.
8. A `:::caution` with a working Pearson VUE scheduling link, only when the default one needs replacing (`https://learn.microsoft.com/credentials/certifications/schedule-through-pearson-vue?examUid=exam.<CODE>&examUrl=...`, no `/en-us/`, no tracking parameter).
9. A `<LinkCard title="Exam <CODE> Study Materials">` to the hub exam page (`/certs/<area>/<code>/`).
10. The closing `:::tip`: not a private access code, first-come first-served for the first 300 people, not available in Turkey, Pakistan, India, or China.
11. The "More About Beta Exams" secondary button to `/certs/vouchers/betaexams/`.
12. Around the page: a `voucherItems` entry in `src/data_files/docs-sidebar.ts` (`{ text: "*80%", variant: "tip" }`), a card to the voucher page in the Get Started card of the exam page (after the study guide, before the How to Prepare card) and the announcement URL in `beta-exams.json`. Delete all of it when the offer has ended (see "Ended offers").

Verify all voucher percentages, codes, limits, deadlines, exclusions, announcement links, and scheduling links from the official source. These facts are time-sensitive; do not record changing inventory totals in this file.

### Components
- Local components live in `src/components/*.astro`
- MDX can import `.astro` components directly
- Use the `@components/docs` barrel for docs components.
- Do not nest `Card` components inside other cards.
- Use `CardGrid` for groups of `LinkCard`s. Empty grids are tolerated on canonical exam tabs but should not be introduced on lab tabs.
- When adding a new resource `LinkCard` to an existing `CardGrid`, place it last unless it is an official Microsoft resource — a Microsoft resource goes after any other Microsoft resources already in that grid, or first if it would be the only resource in the grid.
- External `LinkCard` and `LinkButton` targets use `target="_blank"`; internal links generally do not need it.
- `LinkCard` requires `title` and `href`; `description` is optional and should stay concise.
- For new exam tab blocks, prefer two-space increments (`TabItem` 2, `CardGrid` 4, `LinkCard` 6) without reformatting unrelated legacy content.

### Docs Rendering
- `/certs/` is owned by `src/pages/certs/index.astro`.
- `/certs/<content-id>/` is rendered by `src/pages/certs/[...slug].astro` through `DocsPage.astro` and `DocsShell.astro`.
- Legacy content paths and `/wiki-next/*` redirect permanently to `/certs/*`.
- `remark-callouts.mjs` converts `:::note`, `:::tip`, `:::caution`, and `:::danger` directives to the local `Aside` component.

### Banner System
`AnnouncementBanner.astro` — dismissible banner with localStorage persistence (versioned via `version` prop).
Rendered by `MainLayout.astro` when enabled.

### Key Dependencies
- **@astrojs/mdx** + **@astrojs/markdown-remark** — MDX and Unified remark processing
- **sharp** + **sharp-ico** — Image processing
- **preline** — UI components
- **tailwindcss v4** + **@tailwindcss/typography** + **@tailwindcss/forms**

### CSS
Global styles are in `src/assets/styles/global.css`; docs-specific styles are scoped to the canonical docs components.

### Logo
- Light: `/src/images/logo_light.svg`
- Dark: `/src/images/logo_dark.svg`
- Favicon: `/favicon.svg`

### Sidebar
- Guide, preparation, voucher, and top-level area groups are hand-maintained in `src/data_files/docs-sidebar.ts`.
- Exam entries are generated from the matching `src/content/docs/<area>/` directory by `buildExamItems()`; new exam pages appear automatically.
- Exam status badges are maintained in `src/data_files/exam-status.mjs`: `NEW`, `RETIRED`, `RETIRING`, `BETA`, `UPCOMING`, and `AT RISK`. The same file names each status (`examStatusNames`, e.g. "Retired") and gives the landing page its colours (`examStatusStyles`); the landing page's "Recent status changes" list (`QuickLinksCenter.astro`, which has its own `getStatusClass` switch: a new badge text needs a `case` there) shows every exam that carries one, except that a RETIRED exam is only listed for 90 days after its retirement date (below). The list keeps the order of `examStatuses` (by area, then by exam as written in the file); it is not sorted by date and has no cap. The sidebar reads the statuses through `visibleExamStatuses()` and that list through `recentExamStatuses()`, not `examStatuses` directly.
- Keep exam entries in code order. GA exams have no badge, except NEW (below); beta uses `{ text: "BETA", variant: "tip" }`; retiring uses `{ text: "RETIRING", variant: "danger" }`; retired uses `{ text: "RETIRED", variant: "note" }`.
- **NEW** marks an exam that left beta (or launched straight to GA) less than 90 days ago: `{ text: "NEW", variant: "success", since: "YYYY-MM-DD" }`, shown green. Add it when an exam goes GA, in place of the BETA badge (the Beta Exam Monitor's GA issue says so). `since` is the day Microsoft launched the exam as generally available when that is known, otherwise the day the hub recorded it as GA (the day the monitor flagged it, or the day BETA was removed). The seven exams seeded on 2026-10-15 use the second kind, so their dates are approximate: AI-500 is the day the Beta Exam Monitor flagged it (2026-09-30), and AI-300, AZ-802, DP-800, GH-600, AB-620 and SC-500 the day their BETA badges were removed in a cleanup (2026-09-24), which may be after their real launch. It expires by itself: `visibleExamStatuses()` leaves it out from the 90th day on (`NEW_BADGE_DAYS`; the `since` day is day 0, so the last day shown is `since` + 89), at the next build, and a NEW without a real `since` is never shown. Write `since` as your own calendar day: the checks count in UTC, so a `since` one day ahead of the UTC day (`NEW_BADGE_SKEW_DAYS`) still counts as today, which keeps a push made after your local midnight but before UTC's from failing CI; two days ahead does not. Nothing has to remove the entry afterwards; delete it whenever you like. `tests/scripts/exam-status.test.mjs` keeps the entries valid (real `since` day, at most a day ahead of the UTC day, an existing exam page, no `since` on any other status).
- **RETIRING becomes RETIRED once the retirement date has passed**: the date in `retiring-exams.json` is before today (UTC), the same cut-off as the `RetirementBanner` (which flips to the past tense by itself) and as the Retiring Exam Monitor's follow-up after the date (`docs/monitors/beta-and-retiring-exams.md`). On the retirement day itself the exam is still RETIRING. RETIRED is a first-class status: it is gray in the sidebar (`DocsSidebar.astro` styles the text `RETIRED` itself, the way it does `GA`) and on the landing page, clearly apart from the red RETIRING. The sidebar badge stays for good, but the landing page's "Recent status changes" list drops a RETIRED exam once `RETIRED_LISTED_DAYS` (90) days have passed since its `retirementDate` in `retiring-exams.json` (the retirement day is day 0, so the last day listed is the date + 89; counted at the next build, like NEW). That is why a RETIRED badge needs its tracker entry: `QuickLinksCenter.astro` passes the entries' `retirementDate`s to `recentExamStatuses()`, and a RETIRED exam without a real date there is left out of the list. `tests/scripts/exam-status.test.mjs` checks this and that every exam with a status has its page, so the list never links a deleted exam; if a retired page is ever deleted, remove its badge too. The `retiring-exams.json` entry stays as history (the monitor sets `notified` itself and never notifies again), the exam page and its resources stay, and nothing is deleted or redirected. Checked 2026-10-14: AZ-800 and AZ-801 are RETIRED (retired September 30, 2026, per Microsoft Learn's "Recently retired exams" table, `https://learn.microsoft.com/credentials/support/retired-certification-exams`, and the notice of their exam pages and study guides); MS-102 stays RETIRING until November 30, 2026 has passed. The other 15 exams of that table have no hub page, and no other hub exam page or study guide carries a retired notice.
- Wiki pages are separate from the sidebar: `WikiList.astro` auto-discovers exam pages by area prefix, sorts collection IDs, and extracts a short name from the canonical exam-description template.
- `VoucherList.astro` filters docs by `voucherCategory`, sorts by title, and constructs `/certs/${voucher.id}/` routes.

### Redirects
- Defined in `astro.config.mjs` under `redirects: { ... }`
- Add redirects when exams are renamed/moved or certification structures change; retain legacy routes to avoid broken inbound links.
- When Microsoft renames an exam in place (PL-400 became AB-400 on 2026-10-16, same certification, an updated exam), move the exam page and its lab page to the new code and area (`git mv`, so the history follows), redirect the canonical and the legacy address of both (`/certs/power/pl-400`, `/power/pl-400`, `/certs/labs/power/pl-400`, `/labs/power/pl-400`) in `astro.config.mjs` and, for a real 301, `public/_redirects`, update the internal links, put a note at the top of the page saying what happened, mark the new exam NEW, and keep the resources made for the old exam with its code in their titles (like `AZ-500: Pluralsight Course` on SC-500) until equivalents for the new one exist. An exam that is only retired, with a replacement page of its own, keeps its page and gets the retirement treatment instead.

---

## Content Rules

- **No exam dumps.** Ever.
- **No inventing** URLs, IDs, dates, names, or course titles. Verify against Microsoft Learn.
- Use the Microsoft Learn MCP tools (`microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search`) for that verification when they are available. If you could not verify something, say so instead of guessing.
- Preserve all tracking params (`?WT.mc_id=studentamb_165290`, `#u44`).
- Prefer official Microsoft resources and Microsoft-maintained GitHub repositories. Third-party resources must be reputable and directly relevant.
- Verify exact resource titles and destination URLs before adding them. Never infer labs, courses, assessment IDs, release dates, voucher details, or MeasureUp products from URL patterns alone.
- Keep rendered output identical when refactoring — don't redesign pages.
- Edit with the editor, not terminal redirection. Re-read files right before editing.

---

## Build & Verify

```bash
pnpm install --frozen-lockfile  # Install deps
pnpm build                      # astro check + astro build --force + Pagefind index
pnpm dev                        # Local preview
```

- Build must pass with 0 errors before committing.
- `pnpm build` generates and verifies `dist/pagefind/pagefind.js`; use `pnpm preview` to test site search locally.
- Plain `pnpm dev` does not generate a Pagefind index, so search requires a completed production build.
- `astro build --force` clears the content-layer data store (`node_modules/.astro/data-store.json`) on every build. Cloudflare Pages restores that directory from its build cache, and the incremental loader keys entries on ID + content digest, so a file whose path changed but whose content did not (e.g. a case-only rename) would otherwise keep a stale `filePath` and fail with `Rolldown failed to resolve import "astro:content-layer-deferred-module?...fileName=<old path>"`. The full resync costs about one second on this site; do not remove the flag.
- `astro check` currently prints a few hints and no errors or warnings (mostly unused declarations, plus one deprecated `document.execCommand`). Do not introduce new unused-declaration hints.
- The build validates frontmatter/schema types, MDX syntax, TypeScript, collection uniqueness, and static rendering.
- The build does **not** validate external link availability, tracking parameters, assessment IDs, exam names, voucher accuracy, or duplicate content. Verify these manually against authoritative sources.
- When redirects change, test the old route against the dev server.
- Use `pnpm install --frozen-lockfile` for reproducible installs; commit `pnpm-lock.yaml` when dependencies change.
- No environment variables or secrets are required to build the site; analytics IDs (Google Analytics, Clarity, GTM) are hardcoded in astro.config.mjs.

---

## Key Components

| Component | Purpose |
|-----------|---------|
| `WikiList.astro` | Auto-generates wiki cards by directory prefix |
| `LabList.astro` | Auto-generates lab index cards from `labs/<area>/<code>.mdx` pages |
| `VoucherList.astro` | Auto-generates voucher cards by `voucherCategory` frontmatter |
| `MainLayout.astro` | Global document shell, metadata, scripts, and banner integration |
| `MainLayout.astro` | Main layout wrapper |

---

## CI/CD

- **Platform:** Cloudflare Pages
- **Build command:** `pnpm build`
- **Output directory:** `dist`
- **Node version:** 24 (current LTS)

### GitHub Actions workflows

- **Workflows that push to `main`** (every monitor that commits a tracker): `tests/scripts/workflows.test.mjs` is one test over all of them. No two start in the same minute on the same weekday (the monitors that start at minute 20 do so at different hours: a test over the whole set, not a claim in each monitor's own comment, keeps it true), and every one retries its push three times (`for attempt in 1 2 3; do git pull --rebase && git push && exit 0; ...`). GitHub often starts a scheduled run hours late, so distinct start times are a convenience and the retry is the protection. `tests/scripts/workflow-commit-steps.test.mjs` runs the commit step of each of them for real against a scratch git remote (no commit when the tracker is unchanged, only the files the step names are committed, a rebase onto what landed on `main` meanwhile, a rejected push tried again, a failed step after three rejections); it finds the workflows by their `git push`, so a new one is covered the day it is added. A workflow that starts pushing must be added to the `KNOWN_PUSHERS` list in `tests/scripts/workflows.test.mjs` on purpose.
- **Workflow hygiene** (each rule has a test in `tests/scripts/workflows.test.mjs`, so a new or edited workflow that breaks one fails `pnpm test:scripts`): every `uses:` is pinned to a full 40-character commit SHA with the tag in a trailing comment (`# v6`), and `.github/dependabot.yml` proposes the updates (weekly: one grouped pull request for the actions; for the npm packages of the pnpm workspace one pull request for minor and patch releases, a pull request of its own for every major release, and a 7-day cooldown before a new release is proposed; security updates skip the cooldown); every `actions/setup-node` step reads `node-version-file: .node-version` (24) instead of naming a version; every job has a `timeout-minutes`; `contents: write` is only for the jobs that push; a workflow that pushes to `main` never cancels a run half way (`cancel-in-progress: false`); a monitor opens its issue before it commits its tracker, and a failed issue step skips the commit; CI (`ci.yml`) runs on pull requests, on pushes to `main` and by hand.
- **Failure issues with a stable title:** a monitor that only has a message file (`/tmp/<monitor>-error.md`) must not open "<Monitor> Failed — <run id>" for every failing run (a check that fails every 6 hours would make 4 issues a day). The workflows of the New Exam Monitor (`New Exam Monitor Failed`, `New Exam Monitor: study guide check stopped`), Skills Hub Watch (`Skills Hub Watch Failed`), Learn Content Watch (`Learn Content Watch Failed`) and MeasureUp Monitor (`MeasureUp Monitor Failed`) call `scripts/failure-issue.mjs` (Node, no dependencies, the `gh` CLI and the job token, label `bug`, never an assignee): `raise --title <title> --file <message> [--repeat-hours N]` creates the issue (creating the `bug` label first, with GitHub's own look, when the repository lacks it: `ensureLabel` of `scripts/lib/gh.mjs`, because `gh issue create --label` fails for a missing label) or adds the message as a comment on the oldest open copy (`--repeat-hours 24` keeps a 6-hourly check to one comment a day), and `clear --title <title> --comment <text>` closes every open copy after the next healthy run. A failing `gh` makes the step red. The create-or-comment and close-every-copy steps are the functions `raiseIssue` and `closeOpenIssues`, which Source Watch uses for its own running issues as well. Tests, fully offline (an in-memory `gh`, a fake `gh` script for the command line, and the step order and the raise and clear conditions of the four workflows), are in `tests/scripts/failure-issue.test.mjs`: a change to a failure step of `new-exam-monitor.yml`, `skills-hub-watch.yml`, `learn-content-watch.yml` or `measureup-monitor.yml` has to keep it green. The monitors that still use `peter-evans/create-issue-from-file` with the run id in the title for a failed check (Partner Designation, Learn URL Check, Applied Skills and Voucher Challenge run weekly, so one failure a week at most; the daily Beta Exam Monitor can still open one per failing day) are not moved yet: switch a failure step to the script when its monitor starts failing more often. The runbook of every monitor named here is in `docs/monitors/` (see Monitors).

---

## Missing Resources Audit

Internal to-do list of exam pages that lack a link of a given resource type. Not rendered on the site, not in the sidebar, not part of the build or CI.

- **Script:** `scripts/audit-missing-resources.mjs` — run with `node scripts/audit-missing-resources.mjs`
- **Output:** `src/data_files/missing-resources.json` — `{ "<Resource Type>": ["<CODE>", ...] }`, codes sorted alphanumerically
- **Scope:** every `<CODE>.mdx` in the seven exam areas; pages with `draft: true` are skipped

### What it checks
Only whether the button is present **on our page** — it does not verify that the resource exists on Microsoft Learn or the vendor site. Detection is by `LinkCard` **title**, not URL: a page counts as having a resource type when one of its `<LinkCard title="...">` buttons matches. Hrefs are never inspected.

| Key | Counts as present when the page has a `LinkCard` titled |
|-----|----------------------------------------------------------|
| MS Learn Course | exactly `Microsoft Learn` |
| MS Learn Practice Assessment | starting with `Microsoft Learn Practice Assessment` (covers the `(AI Skills Navigator)` variant) |
| MS Learn Exam Readiness Zone | exactly `Microsoft Learn Exam Readiness Zone` |
| MS Learn On-Demand Instructor-led Training | starting with `On Demand Instructor-led Training Series` (a `: <subtitle>` suffix is fine) |
| Exam Labs | exactly `Exam Labs`, or `Labs and Case Studies` (used only by SC-100, whose lab page also holds case studies) |
| GitHub Labs | n/a on the exam page — present when `labs/<area>/<code>.mdx` exists and its active `<TabItem label="Microsoft GitHub">` tab contains at least one `LinkCard` that is not titled with another exam's code (`MB-330: Case Study 1 Prod Mgmt EX 1 to 4` on AB-330 is a lab kept from the predecessor and does not count) |
| MeasureUp | starting with `MeasureUp ` except `MeasureUp Subscriptions` (the generic link on every page); data-driven pages also count `measureUpReleased: true` |
| Whizlabs | starting with `Whizlab`/`Whizlabs` (case-insensitive) |
| Pluralsight | starting with `Pluralsight` |
| Udemy | containing the word `Udemy` anywhere |
| Microsoft ESI | starting with `Microsoft Enterprise Skills Initiative` (a suffix such as `Instructor-led course` is fine) |

- **ESI is checked by hand.** `esi.microsoft.com` is not public and its page is a script shell, so no monitor can tell whether ESI has training for an exam (the Link Checker and Source Watch cannot read it either, see `docs/monitors/source-watch.md`). The ESI Check Reminder (`docs/monitors/esi-check-reminder.md`) turns this list into a checklist issue every second month. The card is a search by exam code, `https://esi.microsoft.com/Search?q=<CODE>&avail=Available&learningoption=Advanced+Role+Based`, so a maintainer with ESI access opens it for each exam of the list and adds the card (Videos tab, next to the other instructor-led training) only when the search returns training. The ESI voucher page (`src/content/docs/vouchers/microsoftesi.mdx`) names the exams the 50% voucher covers (Azure, Security/Compliance/Identity, Power Platform, Dynamics 365 except MB-335); it does not say which exams have ESI training, so the list is not narrowed to those areas.
- MDX (`{/* */}`) and HTML (`<!-- -->`) comments are stripped first, so commented-out placeholders count as missing.
- Only `<LinkCard>` titles are read; `<Card title="MeasureUp Practice Tests">` containers and `<TabItem label>`s are ignored.
- Buttons borrowed from a predecessor exam (`AZ-800: MeasureUp Assessment` on AZ-802, `AZ-500: Pluralsight Course` on SC-500, `MB-330: MeasureUp Assessment` and the `MB-330:` labs of `labs/aibusiness/ab-330.mdx` on AB-330) intentionally do **not** count — the page still lacks its own resource, which is exactly what the periodic sweep should look for.
- Because detection is name-based, new buttons must use the canonical titles above (e.g. `John Christopher's Course on Udemy`, not `John Christopher SC-200 Course`) or they will be reported as missing.
- To track a new resource type, add one entry to `RESOURCE_TYPES` in the script with the button title it should look for, and re-run.
- An exam that cannot have a resource on purpose is exempt: add it, with the reason, to `scripts/lib/audit-exemptions.mjs` (resource type, then exam code) and re-run the audit; it then no longer appears in that list. Only add an exemption after checking, and write the date of the check in the reason.

### Working the list
1. Pick a key and an exam code from the JSON.
2. Verify the resource actually exists for that exam (Microsoft Learn, MeasureUp, vendor site). Never infer it from URL patterns — see Content Rules.
3. If it exists, add it to the exam page in the correct tab (Exam Page Anatomy) using the normalized URL Formats and tracking params.
4. If it does not exist, leave the entry; the list is expected to contain permanent gaps.
5. Re-run the script and commit the regenerated JSON together with the page edits.

### Known intentional gaps (do not "fix")
- **Exam Labs / GitHub Labs:** AB-100, AZ-305 — design/architect-tier exams with no lab page by design (see Lab Pages). SC-100 is no longer a gap: it is the documented exception with a lab page.
- **GitHub Labs, exempt (left out of the list):** AB-100, AZ-305, AB-731, AZ-401, AZ-700, GH-100, GH-200, GH-300, GH-500, GH-700, GH-900 and DP-750 have no GitHub lab that is not already on the Microsoft Learn tab, so `scripts/lib/audit-exemptions.mjs` leaves them out of the list, each with its reason (checked 2026-10-16). In short: AB-100 and AZ-305 have no lab page by design (see Lab Pages); the GH-100, GH-200, GH-300, GH-500 and GH-900 Learn exercises wrap GitHub Skills repositories (`github.com/skills/*`, for example `hello-github-actions`, `introduction-to-codeql`, `getting-started-with-github-copilot`) and no repository of the `microsoft`, `MicrosoftLearning`, `github`, `Azure` or `skills` organisations names a GH exam code (GH-600 is covered via other Microsoft-owned GitHub repos); DP-750 has a course repository (`MicrosoftLearning/DP-750T00-Implement-Data-Engineering-Solutions-using-Azure-Databricks`) whose labs are the Learn exercise units that wrap them (the unit pages link the repository's Pages instructions), so the Microsoft GitHub tab stays commented out (Lab Page Workflow, no duplicates); AB-731 (a no-code leadership exam) has no repository; AZ-401 and GH-700 have no course yet, and the Lab Repo Check reports their repository when it appears. `tests/scripts/audit-exemptions.test.mjs` fails when an exempt exam names no page, still sits in the JSON, or has got a Microsoft GitHub tab (remove its exemption then).
- **GitHub Labs, AZ-700 (exempt too):** the course repository (`MicrosoftLearning/AZ-700-Designing-and-Implementing-Microsoft-Azure-Networking-Solutions`) is mirrored by the Learn exercises already on the page; its 17 instructor demos in `Instructions/Demos` are not on Learn (checked 2026-10-16), and the maintainers decided on 2026-10-16 not to list them. The list is empty as a result; link the demos on the AZ-700 lab page's Microsoft GitHub tab and remove the exemption if that ever changes.
- **New beta pages (temporary):** AZ-401 and GH-700 were created on 2026-10-14 with empty tabs because Microsoft Learn has no course, practice assessment, lab or MeasureUp product for them yet (`az-401t00` and `gh-700t00` return 404). They show up in most lists of the audit until resources are verified and added; AZ-401 has no lab page or lab repo yet, and `Exam Labs` stays missing for both. AB-330 (beta since 2026-10-16, from the maintainers; its exam page and `ab-330t00` course answer 404, so its Exam link is the certification page) is in the same state.

---

## Monitors

Scheduled GitHub Actions workflows, each with a dependency-free Node script in `scripts/`, that watch Microsoft Learn and other sources, or the hub's own pages, and open GitHub issues when a page needs attention. None of them is rendered on the site or part of the build. Their detail is not in this file: every monitor has a runbook in `docs/monitors/` (workflow, script, tracker, what is alerted, failsafes, running it locally, working its issues), and `docs/monitors/README.md` is the index with the conventions they share.

| Monitor | What it does | Runbook |
|---------|--------------|---------|
| Beta Exam Monitor, Retiring Exam Monitor | Beta exams that went GA; retiring exams (Learn's retirement tables against the hub's tracker, a notification on the retirement day and a follow-up once Learn lists the exam as retired) | `docs/monitors/beta-and-retiring-exams.md` |
| New Exam Monitor | New exams and certifications on Learn, changed study guides, hub pages that no longer match Learn | `docs/monitors/new-exam-monitor.md` |
| Applied Skills Monitor | New and retired Applied Skills against the lab pages that link them | `docs/monitors/applied-skills.md` |
| MeasureUp Monitor | MeasureUp's Microsoft catalog: new products and stale MeasureUp links on exam pages | `docs/monitors/measureup.md` |
| Partner Designation Skilling Requirements | Partner Center pages behind the partner skilling guide page | `docs/monitors/partner-designations.md` |
| Voucher Challenge Monitor | New Microsoft voucher challenge and sweepstakes pages | `docs/monitors/voucher-challenge.md` |
| Voucher Review Monitor | Voucher pages that need a second look (end date, review date, linked exam) and the announcement state of the beta exams | `docs/monitors/voucher-review.md` |
| Learn URL Check | Every `learn.microsoft.com` URL in `src/` against learnsync's data | `docs/monitors/learn-url-check.md` |
| Link Checker | Internal links of the built site, the allowlisted external links, and links that now permanently redirect to a parent page of their own site | `docs/monitors/link-checker.md` |
| Skills Hub Watch | The Skills Hub blog: announcements of exams, betas, vouchers and retirements | `docs/monitors/skills-hub-watch.md` |
| Lab Repo Check | Archived, deleted and new GitHub lab repositories | `docs/monitors/lab-repo-check.md` |
| Learn Content Watch | New practice assessments and instructor-led courses on Learn for the exams the hub covers | `docs/monitors/learn-content-watch.md` |
| Source Watch | The Microsoft program and policy pages, and the programme pages of other hosts, that the guide pages are written from | `docs/monitors/source-watch.md` |
| Tests Review Reminder | One-time issue asking whether the monitors' tests can go | `docs/monitors/tests-review-reminder.md` |
| ESI Check Reminder | Every second month, one issue with a checklist of the exams that have no ESI card and the ESI search address of each, to be checked by hand | `docs/monitors/esi-check-reminder.md` |

`docs/monitors/learn-research-caches.md` is not a monitor: it records where the Microsoft Learn research caches live (`mscerts/learnsync`) and which monitor reads them. The Missing Resources Audit stays in this file: it is a script run by hand, not a workflow.

Rules:

- Before you change, run or debug a monitor, read its runbook in `docs/monitors/` first.
- Code, tests and runbook change together: a change to a monitor's script, workflow or tracker updates its runbook and the tests that read it in the same change. A new monitor comes with its runbook and a row in `docs/monitors/README.md` and in the table above. Durable guidance about a monitor goes into its runbook, not into this file (see Repository Memory).
- This repository is public, so the rule in "Board content stays private" (under Task Board) applies unchanged to runbooks, to the issues the monitors write, and to code comments and commit messages: never copy private board content into them.

---

## Repository Memory

- Merge durable guidance from every `/memories/repo/` file into the relevant section of this `AGENTS.md` file.
- When adding or changing repository memory, update `AGENTS.md` in the same task and consolidate overlapping guidance instead of duplicating it.
- If a memory file conflicts with `AGENTS.md` or another memory file, ask the user which rule should take precedence before merging.
- Do not merge temporary `/memories/session/` notes unless the user explicitly promotes them to durable repository guidance.

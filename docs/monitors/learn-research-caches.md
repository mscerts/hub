# Microsoft Learn Content Research Caches

*Reference note on the Microsoft Learn research caches, which are not a monitor of this repository. Repo-wide rules live in [AGENTS.md](../../AGENTS.md); the monitors are listed in the [index](README.md).*

The local, AI-queryable JSON caches of Microsoft Learn training modules and
documentation pages (formerly `src/data_files/learn-catalog.json` and
`docs-catalog.json`, their sync scripts, and their weekly GitHub Actions
workflows) have moved to a dedicated repo: **https://github.com/mscerts/learnsync**.

They were always pure reference datasets for content research — never
imported by this site's build — so extracting them keeps this repo's history
and CI focused on the actual site, while the caches get their own
independent weekly refresh schedule, issue tracker, and quarantine-triage
workflow.

- **Learn Catalog** (training modules): `data/learn-catalog.json` in that repo, built by `scripts/learn-catalog-sync.mjs`.
- **Docs Catalog** (documentation pages): `data/docs-catalog.json` (+ `data/docs-catalog-invalid.json` quarantine list) in that repo, built by `scripts/docs-catalog-sync.mjs`.

The one consumer in this repo is the **[Learn URL Check](learn-url-check.md)** monitor. Every week it reads only learnsync's two small change files, `data/changes/removed.json` and `moved.json` (every link learnsync knows is gone or moved), plus `data/status.json` and learnsync's own `scripts/lib/` code (`changes.mjs`: `loadChanges`, `indexChanges`, `lookupChange`, `summarizeChanges`; `live-probe.mjs`: `liveLayer`) from a sparse, partial clone, so it never downloads the multi-MB caches. Every month (the first Tuesday, a later scheduled run when the last full audit is more than 35 days old or none is on record, or on demand) it does a full audit: it clones the whole repo and runs learnsync's validator (`scripts/lib/validate.mjs`) over the hub's URLs against its data (`learn-catalog.json` with real unit URLs, `learn-content.json`, `docs-urls.txt`, `docs-redirects.json`, `status.json`). The site build still never imports them.

See `mscerts/learnsync`'s own `AGENTS.md` for the full operational detail:
category filters, subject-enrichment rules, per-repo URL gotchas, the
automated link-checking/quarantine model, and the auto-filed
"investigate newly broken URLs" issue flow. If you're doing content research
that needs either cache (e.g. the hands-on unit/module syntax convention in
`AGENTS.md > Lab Page Workflow`), clone that repo or fetch the file directly from its `main` branch.

# Approval gates: what is accepted, what is rejected, what waits for the maintainer

*Runbook of the approval gates and the review queue (`scripts/course-gates.mjs`, `scripts/lib/course-gates.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). Its input is the judged files of [course-judging.md](course-judging.md); the approval policy it applies is `approvalPolicy` of [courses.md](courses.md).*

A judged candidate has a verdict, a quote that was verified, and a skeptic's opinion. The gates turn that into a **decision** for every candidate of an exam:

| Decision | Meaning |
|----------|---------|
| `accept` | A pick the gates may take on their own, as `core` or `supporting`. |
| `reject` | Not in the course. |
| `queue` | Waits for the maintainer, with the reasons and what is needed to decide. |

What the maintainer decides is **remembered**, per exam, and never asked twice. Nothing here builds a course file or a page; the decisions are what a later step turns into picks.

## The rules

Applied in this order; the first that fits decides.

1. **The maintainer already decided it** (same task and page): the decision stands, as an `accept` with its class and relation or a `reject`. The one exception is a page that is no longer a current Learn page, which is rejected whatever was decided.
2. **An excluded sub-product:** a documentation page whose family (`/entra/id-governance`) the maintainer excluded is rejected.
3. **Not a current Learn page** (with `--urls`: learnsync's validator says it moved, was removed or is a landing page) is rejected.
4. **The judge rejected it with `high` or `medium` confidence** is a rejection. When the judge flagged it `other-role`, `other-sub-product` or `licensing-tier`, the decision carries `remember: true`: an out-of-scope page worth remembering in the course file's rejected list.
5. **The judge rejected it but is not sure** (`confidence: low`) is **never dismissed: it is queued** ("the judge rejected it but is not sure"), because the maintainer is the final judge of every page the AI is unsure about (rule of 2026-10-19). It has no proposed class (`proposal: { "verdict": "reject" }`); to accept it, the maintainer gives a `class` (and a `relation` for `supporting`) and a `note`, which becomes the pick's reason and evidence in the course ([course-build.md](course-build.md)). To reject it, nothing more is needed.
6. **A pick** is accepted unless one of these queues it (all the reasons are listed):

| Reason | Rule |
|--------|------|
| Maintainer only | The approval policy: any `P4` (found by search only), `core` material of another exam's course (`P3`), and any `deeper` dive. |
| Disagreement | The skeptic refuted or downgraded it. A downgrade proposes `supporting` with the skeptic's relation. |
| Not challenged | No skeptic answered for it (`merge --no-skeptic`). |
| Not sure | The judge's confidence is `low`. |
| Flagged | Either answer carries a flag: `other-role`, `other-sub-product`, `licensing-tier`, `level-mismatch`, `preview`, `outdated`. |
| Quote | The quote is not in the evidence, or, for a `core` pick, it carries less than half of the task's distinctive words (`quoteTermCoverage`). A `supporting` pick is not held to the task's words: by definition they are not the guide's. |
| Another sub-product | The generator marked it `foreignFamily`, `siblingSection` or `anchored: false`: not in the families of the task's anchor. |
| Old | Not modified for more than 24 months (the lastmod of `docs-urls.txt` for a documentation page, the catalog's `lastModified` for a module and its units). An unknown age is never a reason. |

An accepted pick is one the gates, not a person, took: its decision is `by: gates` and becomes `by: auto` in the course file. The model case, AZ-104's entitlement-management page under "Manage external users", is caught twice: a judge that saw it rejects it with `other-sub-product` (and the rejection is remembered); a judge that missed it gets `other-sub-product` from the skeptic or the generator's signals, and the page is queued.

## The queue

`gate` writes `<CODE>.queue.json` next to `<CODE>.gated.json`, in `<tmp>/course-gates` unless `--out` says otherwise. The queue is **a file the maintainer edits by hand** (the format of the open decision on the board item: no page, no GitHub issue). Each item carries what is needed to decide: the task, the page and its address to open, the proposal (class and relation), every reason it waits, the judge's reason and quote and the skeptic's answer. To answer, set:

| Field | Meaning |
|-------|---------|
| `decision` | `"accept"` or `"reject"`. Leave `null` to decide later. |
| `class`, `relation` | Optional, to accept as another class than proposed (`supporting` needs a relation; `core` has none). The proposal is used when they are `null`. **Required** to accept a page the judge rejected without being sure: there is no proposal to take. |
| `excludeFamily` | `true` with a reject of a documentation page: every page of that family is rejected from now on. |
| `note` | The reason. For a reject it is what is remembered (default "rejected by the maintainer"). **Required** to accept a page the judge rejected: it replaces the judge's words, which argue against the page. |

`node scripts/course-gates.mjs show <CODE>` prints the queue readably, task by task, with the address of each page.

## Remembered decisions

`resolve` applies the answers to `src/data_files/course-decisions/<CODE>.json`, which is committed like a course file:

```json
{
  "schemaVersion": 1,
  "code": "AZ-104",
  "decisions": [
    { "task": "<task key>", "target": "/entra/id-governance/entitlement-management-overview", "decision": "reject",
      "reason": "Identity governance, not an Azure administrator's job.", "by": "maintainer", "at": "2026-10-17" },
    { "task": "<task key>", "target": "/azure/virtual-network/x", "decision": "accept", "class": "supporting",
      "relation": "operate", "reason": "Worth knowing.", "by": "maintainer", "at": "2026-10-17" }
  ],
  "excludedFamilies": [ { "family": "/entra/id-governance", "reason": "Identity governance.", "at": "2026-10-17" } ]
}
```

Decisions are per task and page (the same page can belong under one task and not another). The file is validated every time it is read (a bad one stops the run with exit code 1); `resolve` applies **nothing** when one answer is wrong; an item that is already decided is an error unless `--replace` says the maintainer changed their mind. After `resolve` the answered items leave the queue file, and the next `gate` uses the decisions: what was decided is not asked again, and an excluded sub-product takes its other pages with it.

## Running it

```bash
node scripts/course-gates.mjs gate AZ-104 [--urls [--live]]     # gated + queue (judged files from course-judge merge)
node scripts/course-gates.mjs show AZ-104                       # read the queue
# edit <tmp>/course-gates/AZ-104.queue.json: decision, class, relation, excludeFamily, note
node scripts/course-gates.mjs resolve AZ-104                    # writes src/data_files/course-decisions/AZ-104.json
node scripts/course-gates.mjs gate AZ-104                       # the answered items are gone from the queue
```

`gate` reads `<CODE>.*.judged.json` from `<tmp>/course-judge` (`--judged DIR`), never overwrites a queue file that has answers not yet applied (run `resolve`, or `--force`), and takes the day from `--today` (default: today, UTC). Ages and URL freshness need a learnsync checkout (`LEARNSYNC_DIR`, else `../learnsync`); without one the age of a page is simply not checked (a warning says so), and `--urls` stops with a message. Exit code 0 done, 1 an answer or the decisions file is not valid, 2 usage or input error.

## Not covered here

- **From decisions to picks.** The gated file lists every candidate with its decision, class, relation and who decided; the builder ([course-build.md](course-build.md)) turns the accepted ones into the picks of a course file, with `by: auto` or `maintainer` and the remembered rejections in its `rejected` list.
- **Per-task rejections only.** A page rejected under one task can come up under another; only a whole documentation family can be excluded for an exam.
- **Freshness of a decision.** A remembered `accept` is kept while the page is current; it is not asked again when the page changes. The rebuild check ([courses.md](courses.md)) is what notices a changed module.
- **One exam has been gated, with no answers yet.** AZ-104, on 2026-10-17 and again on 2026-10-19 under the rule above. The queue is long by design: every `P4` page, every unsure pick and every unsure reject waits. Whether the pilot's "at most 25% queued" target still makes sense with that rule is the maintainer's to decide.

## Tests

`tests/scripts/course-gates.test.mjs` and `course-gates-cli.test.mjs`, offline, on `tests/scripts/helpers/example-judging.mjs` (a judged file of the invented corner of Learn with something for every gate); nothing in them says what a real exam covers.

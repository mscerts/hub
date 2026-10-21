# Approval gates: what is accepted, what is rejected, what waits for the maintainer

*Runbook of the approval gates and the review queue (`scripts/course-gates.mjs`, `scripts/lib/course-gates.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). Its input is the judged files of [course-judging.md](course-judging.md); the rule about who approves a pick is in [courses.md](courses.md).*

A judged candidate has a verdict, the judge's confidence and flags, and a quote that was verified. The gates turn that into a **decision** for every candidate of an exam:

| Decision | Meaning |
|----------|---------|
| `accept` | A pick the gates may take on their own, as `core` or `supporting`. |
| `reject` | Not in the course. |
| `queue` | Waits for the maintainer, with the reasons and what is needed to decide. Only a reject the judge is not sure of and a pick with a quote that is not in the evidence wait here; the picks the judge is unsure of are accepted and marked (rule 6). |

What the maintainer decides is **remembered**, per exam, and never asked twice. Nothing here builds a course file or a page; the decisions are what a later step turns into picks.

## The rules

Applied in this order; the first that fits decides.

1. **The maintainer already decided it** (same task and page): the decision stands, as an `accept` with its class and relation or a `reject`. The one exception is a page that is no longer a current Learn page, which is rejected whatever was decided.
2. **An excluded sub-product:** a documentation page whose family (`/entra/id-governance`) the maintainer excluded is rejected.
3. **Not a current Learn page** (with `--urls`: learnsync's validator says it moved, was removed or is a landing page) is rejected.
3a. **Classic material** (`scripts/lib/course-classic.mjs`: the word "classic" in the title or an address segment) is rejected and nobody is asked: a course leaves it out.
3b. **Hands-on material** (`scripts/lib/course-handson.mjs`: an exercise, a simulation, a guided or challenge project, a tutorial, a quickstart) is not in the course, so there is nothing to decide for it and the maintainer is not asked (maintainer, 2026-10-20: 4 of 60 sampled queue items were exercises or tutorials that belong on the lab page). A page the judge **picked** is accepted, whatever its confidence and flags (they are kept in `warnings`), and the builder sends it to the lab page; one the judge **rejected**, or whose quote is not in the evidence, is rejected. The decision's `via` is `hands-on`.
4. **The judge rejected it with `high` or `medium` confidence** is a rejection. When the judge flagged it `other-role`, `other-sub-product` or `licensing-tier`, the decision carries `remember: true`: an out-of-scope page worth remembering in the course file's rejected list.
5. **The judge rejected it but is not sure** (`confidence: low`) is **never dismissed: it is queued** ("the judge rejected it but is not sure"), because the maintainer is the final judge of every page the AI is unsure about (rule of 2026-10-19). It has no proposed class (`proposal: { "verdict": "reject" }`); to accept it, the maintainer gives a `class` (and a `relation` for `supporting`) and a `note`, which becomes the pick's reason and evidence in the course ([course-build.md](course-build.md)). To reject it, nothing more is needed.
6. **A pick is accepted when the judge picked it and its quote is in the evidence**, whatever its source (`P1` to `P5`), class and confidence (maintainer, 2026-10-20 and 2026-10-21: everything the judge includes is in the course by default; before that a page found by search only, named by a model only, core of another exam's course, a deeper dive or one the judge was unsure of always waited). The one **blocker** is a quote the judge gave that is not in the page text it was shown: the pick is queued.

**Marked for review.** Two things make an accepted pick carry a `review` list instead of queueing it: the judge is not sure of it (`confidence: low`), or the judge flagged it `other-role`, `other-sub-product` or `licensing-tier`. The builder lists these picks in `<course>.review.json` and `node scripts/course-file.mjs render <CODE> --review <file>` writes the **review copy** of the course page: the same page with those cards in orange, numbered in page order and carrying the judge's reason ([courses.md](courses.md)). The maintainer reads them there, in context, and answers with the numbers to drop (`node scripts/course-gates.mjs review <CODE> --course <file> --drop 3,8,10-12`): the dropped ones are rejected, every other marked pick is kept, both are remembered as the maintainer's decisions and the marks disappear at the next build. `gate --queue-unsure` (the `queueUnsure` option) restores the review sheets of 2026-10-21, where those picks wait in the queue file instead.

Four things used to queue a pick as well and are **warnings**: an accepted pick keeps them in the decision's `warnings` (and the `gate` summary counts them), so a person can still find the picks that carry one; with `acceptWithWarnings: false` in the gate options they queue again.

| Warning | Rule |
|---------|------|
| Flagged | The judge carries a flag that is not out of scope: `level-mismatch`, `preview`, `outdated`. |
| Weak quote | For a `core` pick, the quote carries less than half of the task's distinctive words (`quoteTermCoverage`). A `supporting` pick is not held to the task's words: by definition they are not the guide's. |
| Another sub-product | The generator marked it `foreignFamily`, `siblingSection` or `anchored: false`: not in the families of the task's anchor. |
| Old | Not modified for more than 24 months (the lastmod of `docs-urls.txt` for a documentation page, the catalog's `lastModified` for a module and its units). An unknown age is never a warning. |

**There is no skeptic.** Until 2026-10-21 a second model challenged every pick and a refutation queued it. The maintainer's answers showed that it refused pages that were right far more often than pages that were wrong, and a re-run with a narrowed prompt caught none of the pages the maintainer dropped, so the stage was removed (numbers in [course-judging.md](course-judging.md)). What the judge is unsure of or flagged is marked on the review copy of the course page; the queue is its unsure rejects and the picks with a quote that is not in the evidence.

**What was measured, and what was not.** Marked samples of AZ-104: 60 pages the judge was sure of and the skeptic upheld, all 60 kept (95% lower bound about 94%); 17 pages the judge was unsure of and the skeptic upheld, 15 kept; 9 of 9 the skeptic only downgraded kept; 11 of 15 pages the judge rejected without being sure were added: all 10 from P2 to P5 and 1 of 5 from P1 (the exam's own course; two of the four drops were exercises). A person has not checked picks beyond the samples. Of the 103 marked pages that had a judge pick, the 9 the judge flagged `other-role` or `other-sub-product` lost 2 (22%) and the 94 others 4 (4%).

An accepted pick is one the gates, not a person, took: its decision is `by: gates` and becomes `by: auto` in the course file. The model case, AZ-104's entitlement-management page under "Manage external users", is caught when the judge sees it: a judge that rejects it with `other-sub-product` has the rejection remembered, and one that picks it with that flag has it marked for review. A judge that picks it without the flag only gets the generator's "another sub-product" warning and the page is accepted; that case is not caught any more (the skeptic used to be the second chance).

## Fundamentals

A skill group's fundamentals ([courses.md](courses.md)) are candidates of the pseudo-task `<group>/@foundations` and go through the rules above unchanged: the class of an accepted pick is `foundation` (the judge's verdict), a maintainer's decision for such a key is an accept with the class `foundation` (never core or supporting, and no relation) and a decision for a task is never `foundation`. A fundamentals pick the judge was not sure of or flagged out of scope is marked for review like any other.

## The queue

`gate` writes `<CODE>.queue.json` next to `<CODE>.gated.json`, in `<tmp>/course-gates` unless `--out` says otherwise. The queue is **a file the maintainer edits by hand** (the format of the open decision on the board item: no page, no GitHub issue). Each item carries what is needed to decide: the task, the page and its address to open, the proposal (class and relation), every reason it waits, and the judge's reason, confidence, flags and quote. To answer, set:

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
- **One exam has been gated, with no answers yet.** AZ-104, on 2026-10-17, 2026-10-19 and 2026-10-20 (the third time with the rule above and the model proposals). The queue now holds what the AI is unsure about (an unsure judge, an out-of-scope flag, an unsure reject); the pilot's "at most 25% queued" target can be measured again.

## Tests

`tests/scripts/course-gates.test.mjs` and `course-gates-cli.test.mjs`, offline, on `tests/scripts/helpers/example-judging.mjs` (a judged file of the invented corner of Learn with something for every gate); nothing in them says what a real exam covers.

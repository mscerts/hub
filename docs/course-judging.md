# Judging the candidates: verdicts, evidence quotes and a skeptic

*Runbook of the judging protocol (`scripts/course-judge.mjs`, `scripts/lib/course-judge.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). Its input is the shortlist of [course-candidates.md](course-candidates.md); the classes it uses are those of [courses.md](courses.md). What happens to a verdict next (the approval gates and the review queue) is not built yet.*

The candidate generator finds pages that share the words of a task. It cannot tell which of them belong in a course. A judge (an AI) does that, one skill group at a time, and this protocol makes the answer **checkable**:

- the judge must give every candidate a **verdict**, a reason and, for a pick, a **quote** that a script verifies really is in the text it was shown;
- a second, independent model, the **skeptic**, tries to refute every pick;
- the two answers are merged with whether they agree, which is what the gates will decide on.

No AI is part of the code. The scripts build prompts and check, verify and merge answers; a person or an agent session gives a prompt to a model and saves its JSON answer. That keeps keys and model calls out of the repository and out of CI.

## The verdicts

| Verdict | Meaning |
|---------|---------|
| `core` | Covers the task **as the study guide words it**. |
| `supporting` | Not in the guide, but part of the job the task belongs to. Needs a `relation` (`prerequisite`, `same-workflow`, `operate`, `deeper`; their meanings are those of `RELATIONS` in `course-format.mjs`, and the prompt is built from them). |
| `reject` | Everything else, above all **out of scope**: another job role, product area, licensing tier or specialty, however close the keywords look (the model case is AZ-104's "Manage external users" and a page on entitlement management). Also a page that only mentions the keywords, a generic overview, a retired page. |

These are the two classes of a course pick plus rejection; a rejection is what the rejected list of the course file remembers.

The judge may also **flag** a candidate it picks: `other-role`, `other-sub-product`, `licensing-tier`, `level-mismatch`, `preview`, `outdated` (meanings in `FLAGS`). It gives a `confidence` (`high`, `medium`, `low`).

**Two rules of the maintainer, built into the rubric (2026-10-19):**

- **A task has no limit of pages.** A relevant page is a pick, however many others the task already has.
- **A judge that is not sure does not dismiss.** It gives the verdict it leans to with `confidence: low` and says what it is unsure about; it must not lower a verdict "to be safe" or reject what it cannot place (the first rubric said "when in doubt take the lower one", which pushed doubtful pages down into rejects; that rule is gone). A `low` goes to the maintainer, who is the final judge: a `low` pick and a `low` **reject** both wait in the queue ([course-gates.md](course-gates.md)); only a reject with `high` or `medium` confidence is final. A `low` reject should carry a quote, so that the maintainer sees what the judge saw.

## The files

All of a batch's files share a prefix, `<CODE>.<nn>-<group>` (for example `AZ-104.03-manage-microsoft-entra-users-and-groups`), in `<tmp>/course-judge` unless `--out` says otherwise. Nothing is written to the repository.

**A big group is cut into parts.** A skill group with more than 150 candidates (`--max-candidates N`, default `DEFAULT_BATCH_CANDIDATES`) is split into parts of at most that many, in task order and, within a task, in provenance order (`P1` first, `P4` last); a task with more candidates than a part holds continues in the next. A part has its own prefix (`AZ-104.08-create-and-configure-virtual-machines-p3of19`), `batchId` (`<group>#3`) and `part` field, and is judged, checked, challenged and merged on its own; its prompt says which part it is. Every candidate is in exactly one part, nothing is dropped, and the gates read the merged parts as one exam. The batch is written to the prompt as compact JSON (no indentation, about a third fewer tokens than pretty-printed).

| File | Written by | What it is |
|------|-----------|------------|
| `<prefix>.batch.json` | `prepare` | The skill group: its tasks, and per task every candidate with where it came from and its **evidence**. |
| `<prefix>.judge.md` | `prepare` | The judge's prompt: rubric, answer format and the batch. |
| `<prefix>.judgments.json` | the judge | The answer. |
| `<prefix>.skeptic-batch.json`, `<prefix>.skeptic.md` | `skeptic` | The picks with the judge's claim, and the skeptic's prompt. |
| `<prefix>.skeptic.json` | the skeptic | The answer. |
| `<prefix>.judged.json` | `merge` | Both answers per candidate, and whether they agree. |

The **evidence** of a candidate is the text a judge may quote: for a module its title, its unit titles and its products; for a unit its own title, its module's title and the other units of that module; for a documentation page its title, its description and the texts of the links modules use to point to it. It is exactly what the quote check compares with, so the check never depends on anything the judge did not see.

## The judge's answer

```json
{
  "schemaVersion": 1,
  "kind": "judgments",
  "batchId": "networking/configure",
  "judgedBy": "the model or session",
  "judgments": [
    { "task": "<task key>", "target": "/training/modules/x/3-unit", "verdict": "core",
      "why": "One plain sentence.", "quote": "words copied exactly from one evidence snippet",
      "flags": [], "confidence": "high" },
    { "task": "<task key>", "target": "/azure/y/z", "verdict": "supporting", "relation": "prerequisite", "why": "...",
      "quote": "...", "flags": ["preview"], "confidence": "medium" },
    { "task": "<task key>", "target": "/entra/id-governance/w", "verdict": "reject",
      "why": "Identity governance, not part of this job.", "flags": ["other-sub-product"], "confidence": "high" }
  ]
}
```

`check` sends an answer back for each of these (the judge redoes only those entries):

- not the batch's `batchId`, wrong `kind` or `schemaVersion`;
- a candidate not judged, judged twice, or a task or target that is not in the batch;
- a verdict that is not `core`, `supporting` or `reject`; a `supporting` pick without a valid relation; a relation on anything else;
- no `why`, or one over 300 characters; flags that are not in the list; a confidence that is not `high`, `medium` or `low`;
- a pick without a `quote`, an empty one, or one over 200 characters;
- **a pick whose quote is not in the evidence.** The quote is compared by whole words, ignoring case, quote marks, dashes and spacing; it must be at least two words unless it is a whole one-word snippet, and the words must be in order. A `reject` may carry a quote, which is checked and reported but never sends the answer back.

Each quote also gets a `quoteTermCoverage`: the share of the task's distinctive words (an abbreviation counting for its long form) that the quote contains. It is only recorded; the gates will use it, because a quote that says nothing of the task is no evidence for it.

## The skeptic

The skeptic gets the **picks only** (not the rejections), each with the judge's verdict, relation, reason, quote and flags, and the same evidence. For each it answers:

| Stance | Meaning |
|--------|---------|
| `uphold` | It tried to refute the pick and could not. |
| `downgrade` | Not `core`, but still `supporting` (only for a `core` pick; needs a `relation`). |
| `refute` | It should not be a pick at all. |

with a one-sentence `reason`, optional extra `flags` and an optional `quote` (checked the same way). Every pick must be answered once.

## The judged file

`merge` writes, per candidate, `judge` (verdict, relation, reason, quote with `quoteVerified`, `quoteWhere` and `quoteTermCoverage`, flags, confidence) and `skeptic` (picks only), plus:

- `agreement`: `agree` (the skeptic upheld), `disagree` (it downgraded or refuted; `disagreement` says which), or `unchallenged` (a rejection, or no skeptic ran);
- `flags`: the union of both answers' flags;
- the candidate's own card (target, title, source, `via`, signals) without the evidence, which stays in the batch.

Disagreement is recorded and never overwritten: the gates queue it for the maintainer. `stats` counts candidates, verdicts, agreements, disagreements and unverified quotes. `merge` refuses a judgments or skeptic file that `check` would send back, unless `--keep-unverified` keeps a quote that is not in the evidence and marks it (`quoteVerified: false`), which the gates queue.

## Running it

```bash
node scripts/course-candidates.mjs AZ-104                  # the shortlist (course-candidates.md)
node scripts/course-judge.mjs prepare AZ-104 [--group "external"] [--max-candidates 150]   # batches and prompts; prints their size
# give <prefix>.judge.md to the judge, save its JSON as <prefix>.judgments.json
node scripts/course-judge.mjs check <prefix>               # exit 1: the judge redoes the listed entries
node scripts/course-judge.mjs skeptic <prefix>             # the picks and the skeptic's prompt
# give <prefix>.skeptic.md to a FRESH model, save its JSON as <prefix>.skeptic.json
node scripts/course-judge.mjs merge <prefix>               # <prefix>.judged.json
```

How to run the two passes:

- **Who judges:** a local Claude session; with subagents, one per skill group, each given only the contents of `<prefix>.judge.md`. The repository holds no API keys and nothing runs in CI.
- **The skeptic must be independent:** a separate subagent or session that has not seen the judge's reasoning, given only `<prefix>.skeptic.md`. It is useless as a check if it is the judge reading its own answer.
- **Redo only what `check` lists.** Send the judge the entries it names and ask for corrected entries; replace those in the file and check again.
- **Estimate the cost first.** `prepare` prints the size of every prompt in rough tokens (characters / 4) and the total; a skeptic prompt is smaller (picks only). Measured on AZ-104 on 2026-10-17 (shortlist capped): 15 batches, about 0.6 million prompt tokens, and about 5 million tokens of subagent usage in all for judge and skeptic (each session reads its prompt in several steps, so usage is a multiple of the prompt). With no cap (2026-10-19): 13,099 candidates, 95 parts of 3,000 to 45,000 tokens each and about 2.2 million prompt tokens, so expect roughly two to three times that usage. Paths for `check`: use forward slashes in Git Bash (backslashes are eaten there).

## Not covered here

- **The approval gates, the review queue and remembered decisions** read the judged files: auto-accept, queue (any `P4`, a flag, a disagreement, low confidence in a pick **or in a reject**, an unverified quote, a quote that carries little of the task) and auto-reject (only a reject the judge is sure of). See [course-gates.md](course-gates.md).
- **The quote check is on the cached text only** (titles, unit titles, descriptions, link texts). It proves the judge did not make a quote up, not that the page's body says what the judge infers; it cannot be stricter without fetching the live page. If quotes prove too loose, a live check at judge time is the next step.
- **Rejections are not challenged by the skeptic.** A wrong rejection is only caught when the judge itself was unsure (`low` confidence), which sends it to the maintainer; a confident wrong rejection costs recall, not correctness. The skeptic sees the picks only.
- **`judgedBy` is free text.** Nothing checks which model answered or that the skeptic differs from the judge.
- **One exam has been judged, once.** AZ-104, on 2026-10-17 with the shortlist capped, at the maintainer's request (30 subagent sessions). The rubric and the shortlist have changed since (see above); the formal pilot ([course-playbook.md](course-playbook.md)) has not been run.

## Tests

`tests/scripts/course-judge.test.mjs` and `course-judge-cli.test.mjs`, offline. They use `tests/scripts/helpers/example-judging.mjs`, which builds candidates and valid answers on the invented corner of Learn of `example-candidates.mjs`; nothing in it says what a real exam covers or how a real judge answers.

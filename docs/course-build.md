# The course builder: from gated decisions to a course file

*Runbook of the builder (`scripts/course-build.mjs`, `scripts/lib/course-build.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). Its input is the gated file of [course-gates.md](course-gates.md); its output is a course file of the format in [courses.md](courses.md).*

The builder decides nothing. It takes what the earlier steps decided and writes it down as a course file: the study guide's tree, the picks the gates (or the maintainer) accepted, the remembered rejections, and the state of Learn they were judged against.

```bash
node scripts/course-build.mjs AZ-104 [--gated FILE] [--out FILE] [--allow-stale] [--urls [--live]]
```

Inputs:

- the **gated file** (`<tmp>/course-gates/<CODE>.gated.json`, `--gated FILE`): every candidate with its decision;
- the **study guide** the New Exam Monitor stores (`src/data_files/learn-exams.json`, `LEARN_EXAMS_FILE`), parsed: the tree, the exam's name and the guide's hash and date;
- **what Learn offers the exam today**, as for the other course tools (a learnsync checkout, `LEARNSYNC_DIR`, and the catalog API's course list): the scope snapshot the course stores.

The course file is written to `<tmp>/course-build/<CODE>.json`, or to `--out`, with `<CODE>.routing.json` beside it (what the page rules took out, below). **Nothing is written into the repository on its own**: when a course is wanted, the maintainer moves it to `src/data_files/courses/<CODE>.json` and runs `node scripts/course-file.mjs validate <CODE> --live`.

## What goes into the file

| Part | Where it comes from |
|------|--------------------|
| The tree: domains, weights, skill groups, tasks | The study guide, key for key and in order. A task with no accepted pick has an empty list: the explicit "nothing for this task" state. |
| A pick: `target`, `title`, `class`, `relation`, `source` | The accepted gated item: the class and relation the gates gave it (the maintainer's own class included). |
| `decision` of a pick | `{ by: "auto" }` for what the gates accepted, `{ by: "maintainer" }` for what the maintainer decided (with the day they decided it); `at` is the day the gates ran for an automatic one. |
| `why`, `evidence` | The judge's reason and verified quote. The format requires them for a `supporting` pick and for any pick from another exam's course or found by search or named by a model (`P3`, `P4`, `P5`); a core pick of the exam's own course carries neither. **When the maintainer decided the pick, their `note` replaces the judge's words** if they wrote one; and for a page the judge **rejected** and the maintainer accepted, the note is the only reason and evidence there is (the judge's words argue against the page). |
| `via` of a `P2` pick | The module whose last unit lists the page. |
| Order of the picks | Core before supporting, then `P1` to `P5`, then module, unit, documentation page, then how well the candidate matched the task. |
| `inputs.guideHash`, `guideAsOf`, `builtAt` | The guide's text hash and date, and the day of the build. |
| `inputs.scope` and `scopeFingerprint` | The snapshot of the exam's scope map (the official courses and modules with their signatures and link hashes). |
| `inputs.picked` | `[module, unitSig]` for every module outside the official course that a `P3`, `P4` or `P5` pick depends on, once each. |
| `rejected` | What is worth remembering so that it cannot come back: pages the maintainer rejected (their reason and day) and pages the judge rejected as `other-role`, `other-sub-product` or `licensing-tier` (the judge's reason, the day the gates ran). An ordinary rejection, and a page of an excluded sub-product, is not in the list: the decisions file already keeps the latter. |

A candidate that is still **in the queue** is not in the course; the build lists each as a warning so that none is forgotten.

## The rules of the page

After the accepted items are read, and before the course is written, the builder applies three rules (maintainer, 2026-10-20; the format is in [courses.md](courses.md)). Neither decides relevance; what they take out is written to `<out>.routing.json` and counted in the summary line.

- **Classic pages leave the course.** An accepted page whose title has the word "classic", or whose address has a `classic` segment (`course-classic.mjs`), is dropped and listed in `routing.classic` with the tasks it was accepted for. The candidate generator filters these before judging, so this catches pages judged before the rule or accepted by hand; the build prints how many.
- **Hands-on pages leave the course.** An accepted page that `course-handson.mjs` calls hands-on (an exercise or simulation unit, a unit of a guided or challenge project, a guided or challenge project module, a docs tutorial or quickstart, an Applied Skill) is not a pick: the lab page collects it. `routing.handsOn` lists each once with its title, kind, reason, the module it is in and every task it was accepted for. [course-labs.md](course-labs.md) turns that list into the cards the lab page lacks.
- **A page is shown once.** A page accepted for several tasks stays under one: **core before supporting, a sure judgement (the judge not unsure) before an unsure one, the exam's own course (`P1`) before the other sources, then the task that has the fewest picks so far** (so that the thin tasks fill first), then the better evidence quote, then the earlier task. The pages that fit one task are placed first, so that the load is known; the result does not depend on the order of the gated file. `routing.repeats` lists, for every such page, the task it stays under and the tasks it also fitted.

A task may end up with fewer picks than the gates accepted for it; that is the cost of showing a page once, and the routing file says which pages it still fits.

## When it refuses

The build stops (exit code 1, nothing written) when:

- **The inputs changed since the candidates were made.** The course records the snapshot of Learn it is built on, and the rebuild check compares it with later states of Learn; a snapshot newer than what the picks were judged against would hide a change in between. So a different guide hash, or a different scope fingerprint, means: make the candidates, judge and gate again. `--allow-stale` builds anyway and says so; the course then records the current state, with the picks of the older one.
- **A pick cannot be written as the format wants:** a `supporting` pick, or one from `P3`/`P4`, whose judge gave no quote and for which the maintainer wrote no note; a `supporting` or `P3`/`P4` pick that the maintainer accepted over the judge's reject without a note (answer it again with one); a `P3`/`P4` pick whose module's signature is not in the gated file.
- **A gated task is not in the guide** (the candidates were made for another version of it).
- **The built course does not pass the validator** (`validateCourse`, offline). The builder runs it on its own result, so a file it writes is one the validator accepts.
- **With `--urls`**, a pick is not a current Learn page (learnsync's validator; `--live` also asks Learn about what the caches cannot settle).

Exit code 2 is an input problem: no gated file, no stored guide or exam name, Learn or learnsync unreadable.

## Not covered here

- **Rendering.** The page is `node scripts/course-file.mjs render <CODE> --out <page>` from the course file. There are no draft pages (maintainer, 2026-10-21): the page is an ordinary page of the site, and nothing links it until the maintainer links it from the exam pages, the sidebar or the landing page.
- **The picks to look at.** The build writes `<out>.review.json` beside the course file: every pick the judge was not sure of or flagged as another role, product area or licensing tier (`reasons`, the judge's `why`, `class`, `relation`), in the guide's order. They are in the course; `render <CODE> --review <out>.review.json --out <page>` writes the review copy ([courses.md](courses.md)). A pick the maintainer decided has no mark.
- **Rebuilding a course.** When the guide or Learn changes, `node scripts/course-status.mjs <CODE>` says what to redo; a rebuild is the pipeline again for the tasks it names. Nothing merges an old course with a new build yet: a rebuilt course is the whole new file.
- **No exam has been built.** The builder and its tests exist, with an invented exam; the first real build is the pilot, which waits for the maintainer.

## Tests

`tests/scripts/course-build.test.mjs`, `course-routing.test.mjs` (the page rules) and `course-build-cli.test.mjs`, offline, on the invented exam of `tests/scripts/helpers/example-judging.mjs` and `example-candidates.mjs`. One test closes the loop: a built course renders, and the rebuild check says `current` the moment it is built.

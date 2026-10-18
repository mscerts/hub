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

The course file is written to `<tmp>/course-build/<CODE>.json`, or to `--out`. **Nothing is written into the repository on its own**: when a course is wanted, the maintainer moves it to `src/data_files/courses/<CODE>.json` and runs `node scripts/course-file.mjs validate <CODE> --live`.

## What goes into the file

| Part | Where it comes from |
|------|--------------------|
| The tree: domains, weights, skill groups, tasks | The study guide, key for key and in order. A task with no accepted pick has an empty list: the explicit "nothing for this task" state. |
| A pick: `target`, `title`, `class`, `relation`, `source` | The accepted gated item: the class and relation the gates gave it (a downgrade by the skeptic, or the maintainer's own class, included). |
| `decision` of a pick | `{ by: "auto" }` for what the gates accepted, `{ by: "maintainer" }` for what the maintainer decided (with the day they decided it); `at` is the day the gates ran for an automatic one. |
| `why`, `evidence` | The judge's reason and verified quote. The format requires them for a `supporting` pick and for any pick from another exam's course or found by search (`P3`, `P4`); a core pick of the exam's own course carries neither. |
| `via` of a `P2` pick | The module whose last unit lists the page. |
| Order of the picks | Core before supporting, then `P1` to `P4`, then module, unit, documentation page, then how well the candidate matched the task. |
| `inputs.guideHash`, `guideAsOf`, `builtAt` | The guide's text hash and date, and the day of the build. |
| `inputs.scope` and `scopeFingerprint` | The snapshot of the exam's scope map (the official courses and modules with their signatures and link hashes). |
| `inputs.picked` | `[module, unitSig]` for every module outside the official course that a `P3` or `P4` pick depends on, once each. |
| `rejected` | What is worth remembering so that it cannot come back: pages the maintainer rejected (their reason and day) and pages the judge rejected as `other-role`, `other-sub-product` or `licensing-tier` (the judge's reason, the day the gates ran). An ordinary rejection, and a page of an excluded sub-product, is not in the list: the decisions file already keeps the latter. |

A candidate that is still **in the queue** is not in the course; the build lists each as a warning so that none is forgotten.

## When it refuses

The build stops (exit code 1, nothing written) when:

- **The inputs changed since the candidates were made.** The course records the snapshot of Learn it is built on, and the rebuild check compares it with later states of Learn; a snapshot newer than what the picks were judged against would hide a change in between. So a different guide hash, or a different scope fingerprint, means: make the candidates, judge and gate again. `--allow-stale` builds anyway and says so; the course then records the current state, with the picks of the older one.
- **A pick cannot be written as the format wants:** a `supporting` pick, or one from `P3`/`P4`, whose judge gave no quote (typically a candidate the maintainer accepted that the judge had rejected: it has no evidence to quote); a `P3`/`P4` pick whose module's signature is not in the gated file.
- **A gated task is not in the guide** (the candidates were made for another version of it).
- **The built course does not pass the validator** (`validateCourse`, offline). The builder runs it on its own result, so a file it writes is one the validator accepts.
- **With `--urls`**, a pick is not a current Learn page (learnsync's validator; `--live` also asks Learn about what the caches cannot settle).

Exit code 2 is an input problem: no gated file, no stored guide or exam name, Learn or learnsync unreadable.

## Not covered here

- **Rendering and publishing.** The page is `node scripts/course-file.mjs render <CODE> --out <page>` from the course file; the page is a draft (`draft: true`) so that the site leaves it out until `render --publish` says otherwise, which is the maintainer's decision.
- **Rebuilding a course.** When the guide or Learn changes, `node scripts/course-status.mjs <CODE>` says what to redo; a rebuild is the pipeline again for the tasks it names. Nothing merges an old course with a new build yet: a rebuilt course is the whole new file.
- **No exam has been built.** The builder and its tests exist, with an invented exam; the first real build is the pilot, which waits for the maintainer.

## Tests

`tests/scripts/course-build.test.mjs` and `course-build-cli.test.mjs`, offline, on the invented exam of `tests/scripts/helpers/example-judging.mjs` and `example-candidates.mjs`. One test closes the loop: a built course renders, and the rebuild check says `current` the moment it is built.

// A fake `gh` for the drift issue tests (GH_CLI_SCRIPT). It keeps its issues in
// the file named by FAKE_GH_STATE and logs every call to FAKE_GH_LOG, one JSON
// object per line: { command, args, stdin }. FAKE_GH_FAIL is a comma separated
// list of commands ("issue create", "issue list") that fail on purpose.
// FAKE_GH_TODAY (YYYY-MM-DD) is the day an issue counts as closed (closedAt).
// Like the real CLI, `issue list --json a,b` returns only the fields asked for,
// `--state` picks open or closed issues, and `issue view N --json body` returns
// the text of one issue.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const args = process.argv.slice(2);
const arg = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const command = args.slice(0, 2).join(" ");
const stdin = arg("--body-file") === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(
  process.env.FAKE_GH_LOG,
  JSON.stringify({ command, args, stdin }) + "\n",
);

if (
  process.env.FAKE_GH_FAIL &&
  process.env.FAKE_GH_FAIL.split(",").includes(command)
) {
  console.error(`fake gh: ${command} failed on purpose`);
  process.exit(1);
}

const stateFile = process.env.FAKE_GH_STATE;
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { next: 1, issues: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const find = () =>
  state.issues.find((issue) => issue.number === Number(args[2]));
const pick = (issue, fields) =>
  Object.fromEntries(fields.map((field) => [field, issue[field]]));

if (command === "issue list") {
  const label = arg("--label");
  const wanted = arg("--state") ?? "open";
  const fields = (arg("--json") ?? "number,title").split(",");
  console.log(
    JSON.stringify(
      state.issues
        .filter(
          (issue) => issue.state === wanted && issue.labels.includes(label),
        )
        .map((issue) => pick(issue, fields)),
    ),
  );
} else if (command === "issue view") {
  const fields = (arg("--json") ?? "number,title").split(",");
  console.log(JSON.stringify(pick(find(), fields)));
} else if (command === "issue create") {
  const issue = {
    number: state.next++,
    title: arg("--title"),
    labels: [arg("--label")],
    body: stdin,
    state: "open",
    comments: [],
  };
  state.issues.push(issue);
  save();
  console.log(`https://github.com/mscerts/hub/issues/${issue.number}`);
} else if (command === "issue comment") {
  find().comments.push(stdin);
  save();
} else if (command === "issue edit") {
  find().body = stdin;
  save();
} else if (command === "issue close") {
  const issue = find();
  issue.state = "closed";
  issue.closedAt = `${process.env.FAKE_GH_TODAY ?? "2026-10-09"}T08:00:00Z`;
  issue.comments.push(arg("--comment"));
  save();
}

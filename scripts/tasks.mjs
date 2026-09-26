#!/usr/bin/env node
/**
 * Private task board helper for coding agents (GitHub Projects draft items via gh).
 *
 * Board items are DRAFT items: they live only in the private project, never in
 * this public repository. Any agent that can run a shell command can use this.
 *
 * Usage:
 *   node scripts/tasks.mjs list [--all] [--mine] [--json]
 *   node scripts/tasks.mjs show <ref> [--json]
 *   node scripts/tasks.mjs add "<title>" [--body "<text>"] [--status "<option>"] [--priority "<P0|P1|P2>"] [--due "<yyyy-mm-dd>"]
 *   node scripts/tasks.mjs start <ref> [--force]
 *   node scripts/tasks.mjs done|unclaim <ref>
 *   node scripts/tasks.mjs archive <ref>
 *   node scripts/tasks.mjs status <ref> "<option>"
 *   node scripts/tasks.mjs priority <ref> "<P0|P1|P2>"
 *   node scripts/tasks.mjs due <ref> "<yyyy-mm-dd>"
 *   node scripts/tasks.mjs note <ref> "<text>"
 *   node scripts/tasks.mjs link <ref> <url>
 *   node scripts/tasks.mjs refresh
 *   node scripts/tasks.mjs init --owner <org-or-user> --project <number> [--create-fields]
 *
 * One-time setup per machine (a human runs this, not the agent):
 *   gh auth refresh -s project
 *   node scripts/tasks.mjs init --owner <org-or-user> --project <number>
 * init writes .tasks.local.json (gitignored) with the project and field IDs.
 *
 * gh details this script handles:
 *   - Field edits need the project ITEM id (PVTI_...) plus --project-id,
 *     --field-id and --single-select-option-id (or --text).
 *   - Title/body edits need the DRAFT content id (DI_..., "content.id" in
 *     `gh project item-list --format json`).
 *   - gh cannot edit a draft's field by name: --field only works with an
 *     issue or PR --url.
 *   - Ownership is tracked with real GitHub assignees, not a custom field.
 *     `item-list --format json` already returns a top-level "assignees"
 *     array of logins when set (absent when empty) -- toView() reads it
 *     directly. Writing has no CLI flag though: `gh project item-edit` only
 *     supports custom fields, so start/unclaim call the
 *     `updateProjectV2DraftIssue` GraphQL mutation directly.
 *   - `gh project item-list` lags a few seconds behind writes (resolveItem
 *     retries on a miss); a direct `node(id: ...)` lookup does not, which is
 *     why `note` reads/verifies the Log body that way instead.
 *   - The Log body has no compare-and-swap in the API: `note` reads fresh,
 *     writes, and reads back to confirm nothing raced it, retrying from the
 *     latest body otherwise so a concurrent note is never silently dropped.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, ".tasks.local.json");

const USAGE = `Usage: node scripts/tasks.mjs <command> [ref] [text] [options]

  list [--all] [--mine] [--json]     Open items (Done hidden unless --all)
  show <ref> [--json]                Title, status, priority, due, owner, link and Log
  add "<title>" [--body "<text>"] [--force]  New draft item (default Status,
                                      or --status/--priority/--due; fails on a
                                      duplicate open title unless --force)
  start <ref> [--force]              Claim: sets you as assignee
  unclaim <ref>                      Release your claim: clears the assignee
  done <ref>                         Move Status to Done
  archive <ref>                      Archive the item (hides it from list)
  status <ref> "<option>"            Set any Status option by name
  priority <ref> "<P0|P1|P2>"        Set the Priority field
  due <ref> "<yyyy-mm-dd>"           Set the End date (due date) field
  note <ref> "<text>"                Append a timestamped line to the Log
  link <ref> <url>                   Set the Link field (PR URL)
  refresh                            Re-read field and option IDs
  init --owner <o> --project <n> [--create-fields]

<ref> is the REF column from 'list' (or any unique 6+ character suffix of the
full id). Put -- before any argument that starts with a dash.`;

class TaskError extends Error {}

function fail(message) {
  throw new TaskError(message);
}

// ---------------------------------------------------------------------------
// gh wrappers
// ---------------------------------------------------------------------------
function gh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(
        "GitHub CLI (gh) not found on PATH. Install it, then run: gh auth login; gh auth refresh -s project",
      );
    }
    const detail = String(error.stderr ?? "")
      .trim()
      .split("\n")
      .pop();
    fail(
      `gh ${args[0]} ${args[1]} failed: ${detail || `exit ${error.status}`}. Check 'gh auth status' (needs the project scope).`,
    );
  }
}

function ghJson(args) {
  const out = gh(args).trim();
  return out ? JSON.parse(out) : null;
}

// ---------------------------------------------------------------------------
// Config and board helpers
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!existsSync(configPath)) {
    fail(
      `Task board not configured on this machine (${configPath} missing). A human must run once: node scripts/tasks.mjs init --owner <login> --project <number>`,
    );
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function saveConfig(cfg) {
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

// gh keys item-list field values by the field name with a lower-cased first letter.
function fieldKey(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

// Project item ids look like PVTI_xxxxxxxxxxxxxxxxx-yyyyyyy: everything after
// the last "-" is the part unique to this item. Using that (instead of a
// fixed-length tail) guarantees a ref never starts with "-", which a CLI
// arg parser would otherwise mistake for an option -- forcing a `--`
// workaround on every single command that takes a ref.
function shortRef(id) {
  const dash = id.lastIndexOf("-");
  return dash === -1 ? id.slice(-8) : id.slice(dash + 1);
}

function readFields(owner, project) {
  const res = ghJson([
    "project",
    "field-list",
    String(project),
    "--owner",
    owner,
    "--format",
    "json",
    "-L",
    "100",
  ]);
  const fields = {};
  for (const field of res?.fields ?? []) {
    const options = {};
    for (const option of field.options ?? []) options[option.name] = option.id;
    fields[field.name] = { id: field.id, type: field.type, options };
  }
  return fields;
}

// `gh project item-list` already returns a top-level "assignees" array of
// logins when an item has any (it's simply absent when empty) -- read that
// directly in toView(). Writing has no CLI flag, though: `gh project
// item-edit` only supports custom fields, so start/unclaim call the
// `updateProjectV2DraftIssue` mutation directly.
function setAssignee(draftId, userId) {
  gh([
    "api",
    "graphql",
    "-f",
    "query=mutation($id: ID!, $user: ID!) { updateProjectV2DraftIssue(input: { draftIssueId: $id, assigneeIds: [$user] }) { draftIssue { id } } }",
    "-F",
    `id=${draftId}`,
    "-F",
    `user=${userId}`,
  ]);
}

function clearAssignees(draftId) {
  gh([
    "api",
    "graphql",
    "-f",
    "query=mutation($id: ID!) { updateProjectV2DraftIssue(input: { draftIssueId: $id, assigneeIds: [] }) { draftIssue { id } } }",
    "-F",
    `id=${draftId}`,
  ]);
}

function archiveItem(cfg, itemId) {
  gh([
    "project",
    "item-archive",
    String(cfg.project),
    "--owner",
    cfg.owner,
    "--id",
    itemId,
  ]);
}

function requireDraft(item, action) {
  const draftId = item.content?.id;
  if (!draftId?.startsWith("DI_")) {
    fail(
      `This item is not a draft issue; ${action} on the issue or PR itself.`,
    );
  }
  return draftId;
}

function listItems(cfg, query) {
  const args = [
    "project",
    "item-list",
    String(cfg.project),
    "--owner",
    cfg.owner,
    "--format",
    "json",
    "-L",
    "500",
  ];
  // One token, because the query value can start with a dash.
  if (query) args.push(`--query=${query}`);
  return ghJson(args)?.items ?? [];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `gh project item-list` lags a few seconds behind writes (a just-created or
// just-archived item can be briefly invisible even though it already exists
// on the board). Retrying here -- instead of failing immediately -- avoids
// an agent reading "no board item matches" as "the write failed" and
// retrying the write itself, which would create a duplicate item. Only the
// not-found path pays this cost; a match on the first attempt returns
// immediately.
const RESOLVE_RETRY_DELAYS_MS = [1000, 2000, 3000, 4000];

function resolveItem(cfg, ref) {
  if (!ref) {
    fail(
      "Missing item reference: the REF from 'list' (or a unique 6+ character suffix of the full id).",
    );
  }
  for (let attempt = 0; ; attempt++) {
    const hits = listItems(cfg).filter(
      (item) => item.id === ref || (ref.length >= 6 && item.id.endsWith(ref)),
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      fail(`'${ref}' matches ${hits.length} items; use more characters.`);
    }
    if (attempt >= RESOLVE_RETRY_DELAYS_MS.length) {
      fail(`No board item matches '${ref}'.`);
    }
    sleepSync(RESOLVE_RETRY_DELAYS_MS[attempt]);
  }
}

function toView(item) {
  const content = item.content ?? {};
  const owner = (item.assignees ?? []).join(", ");
  return {
    ref: shortRef(item.id),
    id: item.id,
    status: item[fieldKey("Status")] ?? null,
    priority: item[fieldKey("Priority")] ?? null,
    due: item[fieldKey("End date")] ?? null,
    owner: owner || null,
    link: item[fieldKey("Link")] ?? null,
    type: content.type ?? null,
    title: content.title ?? null,
    body: content.body ?? "",
  };
}

function setSingleSelect(cfg, itemId, fieldName, optionName) {
  const field = cfg.fields[fieldName];
  if (!field) {
    fail(
      `The board has no '${fieldName}' field. Add it, then run: node scripts/tasks.mjs refresh`,
    );
  }
  const optionId = field.options?.[optionName];
  if (!optionId) {
    const names = Object.keys(field.options ?? {}).join(", ");
    fail(
      `'${fieldName}' has no option '${optionName}'. Available: ${names}. (Added options on the board? Run 'refresh'.)`,
    );
  }
  gh([
    "project",
    "item-edit",
    "--id",
    itemId,
    "--project-id",
    cfg.projectId,
    "--field-id",
    field.id,
    "--single-select-option-id",
    optionId,
  ]);
}

function setText(cfg, itemId, fieldName, value) {
  const field = cfg.fields[fieldName];
  if (!field) {
    fail(
      `The board has no '${fieldName}' field. Add it (type Text), then run: node scripts/tasks.mjs refresh`,
    );
  }
  gh([
    "project",
    "item-edit",
    "--id",
    itemId,
    "--project-id",
    cfg.projectId,
    "--field-id",
    field.id,
    "--text",
    value,
  ]);
}

function setDate(cfg, itemId, fieldName, value) {
  const field = cfg.fields[fieldName];
  if (!field) {
    fail(
      `The board has no '${fieldName}' field. Add it (type Date), then run: node scripts/tasks.mjs refresh`,
    );
  }
  gh([
    "project",
    "item-edit",
    "--id",
    itemId,
    "--project-id",
    cfg.projectId,
    "--field-id",
    field.id,
    "--date",
    value,
  ]);
}

function appendLog(body, line) {
  const old = (body ?? "").trimEnd();
  if (!old) return `## Log\n${line}`;
  if (/^## Log\s*$/m.test(old)) return `${old}\n${line}`;
  return `${old}\n\n## Log\n${line}`;
}

// Read the draft's body directly by its own id, not via listItems()/item-list
// (which can lag a few seconds behind writes -- see resolveItem). A direct
// node lookup has shown no such lag in testing.
function fetchDraftBody(draftId) {
  const res = ghJson([
    "api",
    "graphql",
    "-f",
    "query=query($id: ID!) { node(id: $id) { ... on DraftIssue { body } } }",
    "-F",
    `id=${draftId}`,
  ]);
  return res?.data?.node?.body ?? "";
}

// `gh project item-edit --body` replaces the whole body, and there's no
// compare-and-swap for it in the API -- so two near-simultaneous notes can
// race: both read the same body, both append, the second write silently
// drops the first note. Mitigate with optimistic retry: read fresh, write,
// then read back to confirm nothing else wrote in between. If it doesn't
// match, someone raced us -- re-read their latest body and try again from
// there, so our line is never silently lost. Worst case on a genuine
// collision is our line appearing twice, never disappearing.
const LOG_WRITE_ATTEMPTS = 3;

function writeLogLine(draftId, line) {
  for (let attempt = 1; attempt <= LOG_WRITE_ATTEMPTS; attempt++) {
    const next = appendLog(fetchDraftBody(draftId), line);
    gh(["project", "item-edit", "--id", draftId, "--body", next]);
    if (fetchDraftBody(draftId) === next) return;
  }
  fail(
    `Could not append the note without a conflicting concurrent edit after ${LOG_WRITE_ATTEMPTS} attempts. Try again.`,
  );
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function init(opts) {
  const project = Number.parseInt(opts.project ?? "", 10);
  if (!opts.owner || !(project > 0)) {
    fail(
      "init needs --owner <org-or-user> and --project <number> (from the board URL).",
    );
  }
  const me = gh(["api", "user", "--jq", ".login"]).trim();
  const meId = gh(["api", "user", "--jq", ".node_id"]).trim();
  const board = ghJson([
    "project",
    "view",
    String(project),
    "--owner",
    opts.owner,
    "--format",
    "json",
  ]);
  let fields = readFields(opts.owner, project);

  if (opts["create-fields"] && !fields.Link) {
    gh([
      "project",
      "field-create",
      String(project),
      "--owner",
      opts.owner,
      "--name",
      "Link",
      "--data-type",
      "TEXT",
    ]);
    console.log("Created field 'Link' (text)");
    fields = readFields(opts.owner, project);
  }

  const cfg = {
    owner: opts.owner,
    project,
    projectId: board.id,
    me,
    meId,
    // Status on this board is a work category (Bugs/Issues, Wiki, ...), not a
    // pipeline: only these two names are ever written by this script.
    defaultStatus: "Planned future fixes/changes",
    doneStatus: "Done",
    fields,
  };
  saveConfig(cfg);
  console.log(
    `Saved ${configPath} for project '${board.title}' (#${project}, owner ${opts.owner}) as '${me}'.`,
  );
  if (!fields.Status) {
    console.warn("Warning: no 'Status' field found on the board.");
    return;
  }
  for (const name of [cfg.defaultStatus, cfg.doneStatus]) {
    if (!fields.Status.options[name]) {
      console.warn(
        `Warning: Status option '${name}' is missing. Add it on the board (or edit defaultStatus/doneStatus in ${configPath}), then run 'refresh'.`,
      );
    }
  }
}

function list(cfg, opts) {
  const doneName = cfg.doneStatus;
  const views = listItems(cfg, opts.all ? null : `-status:"${doneName}"`)
    .map(toView)
    .filter((v) => opts.all || v.status !== doneName)
    .filter((v) => !opts.mine || v.owner === cfg.me);
  if (opts.json) {
    console.log(
      JSON.stringify(
        views.map(({ ref, id, status, priority, due, owner, title, link }) => ({
          ref,
          id,
          status,
          priority,
          due,
          owner,
          title,
          link,
        })),
      ),
    );
    return;
  }
  if (views.length === 0) {
    console.log("No matching items.");
    return;
  }
  const row = (ref, status, priority, due, owner, title) =>
    `${ref.padEnd(9)} ${status.padEnd(12)} ${priority.padEnd(4)} ${due.padEnd(11)} ${owner.padEnd(14)} ${title}`;
  console.log(row("REF", "STATUS", "PRI", "DUE", "OWNER", "TITLE"));
  for (const v of views) {
    console.log(
      row(
        v.ref,
        v.status ?? "",
        v.priority ?? "",
        v.due ?? "",
        v.owner ?? "",
        v.title ?? "",
      ),
    );
  }
}

function show(cfg, ref, opts) {
  const v = toView(resolveItem(cfg, ref));
  if (opts.json) {
    console.log(JSON.stringify(v));
    return;
  }
  console.log(`Title   : ${v.title}`);
  console.log(`Ref     : ${v.ref}   (${v.id})`);
  console.log(
    `Status  : ${v.status ?? ""}   Priority: ${v.priority ?? "(none)"}   Owner: ${v.owner ?? ""}`,
  );
  if (v.due) console.log(`Due     : ${v.due}`);
  if (v.link) console.log(`Link    : ${v.link}`);
  console.log("");
  console.log(v.body);
}

function add(cfg, title, opts) {
  if (!title) fail('add needs a title: node scripts/tasks.mjs add "<title>"');
  if (!opts.force) {
    const dup = listItems(cfg).find(
      (item) =>
        item.content?.title === title &&
        item[fieldKey("Status")] !== cfg.doneStatus,
    );
    if (dup) {
      fail(
        `An open item titled '${title}' already exists (${shortRef(dup.id)}). Run 'show ${shortRef(dup.id)}' to check it, or pass --force to create a duplicate anyway.`,
      );
    }
  }
  const args = [
    "project",
    "item-create",
    String(cfg.project),
    "--owner",
    cfg.owner,
    "--title",
    title,
    "--format",
    "json",
  ];
  if (opts.body) args.push("--body", opts.body);
  const created = ghJson(args);
  const status = opts.status ?? cfg.defaultStatus;
  setSingleSelect(cfg, created.id, "Status", status);
  if (opts.priority) {
    setSingleSelect(cfg, created.id, "Priority", opts.priority);
  }
  if (opts.due) {
    setDate(cfg, created.id, "End date", opts.due);
  }
  console.log(
    `Created ${shortRef(created.id)} [${status}${opts.priority ? `, ${opts.priority}` : ""}${opts.due ? `, due ${opts.due}` : ""}] ${title}`,
  );
}

function start(cfg, ref, opts) {
  const item = resolveItem(cfg, ref);
  const v = toView(item);
  const others = (item.assignees ?? []).filter((login) => login !== cfg.me);
  if (others.length && !opts.force) {
    fail(
      `Already claimed by '${others.join(", ")}'. Pick another task or coordinate first (--force overrides).`,
    );
  }
  const draftId = requireDraft(item, "set its assignee");
  setAssignee(draftId, cfg.meId);
  const checkoutNote = others.length
    ? `- ${timestamp()} [${cfg.me}] Checked out (was claimed by ${others.join(", ")})`
    : `- ${timestamp()} [${cfg.me}] Checked out`;
  writeLogLine(draftId, checkoutNote);
  console.log(`Started ${v.ref}: ${v.title}`);
}

function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      owner: { type: "string" },
      project: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      status: { type: "string" },
      priority: { type: "string" },
      due: { type: "string" },
      "create-fields": { type: "boolean" },
      all: { type: "boolean" },
      mine: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command = "help", ref, ...rest] = positionals;
  const text = rest.join(" ").trim();

  if (opts.help || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "init") {
    init(opts);
    return;
  }

  const cfg = loadConfig();
  switch (command) {
    case "refresh":
      cfg.fields = readFields(cfg.owner, cfg.project);
      saveConfig(cfg);
      console.log("Field and option IDs refreshed.");
      break;
    case "list":
      list(cfg, opts);
      break;
    case "show":
      show(cfg, ref, opts);
      break;
    case "add":
      add(cfg, opts.title ?? [ref, ...rest].filter(Boolean).join(" "), opts);
      break;
    case "start":
      start(cfg, ref, opts);
      break;
    case "unclaim": {
      const item = resolveItem(cfg, ref);
      const draftId = requireDraft(item, "clear its assignee");
      clearAssignees(draftId);
      writeLogLine(draftId, `- ${timestamp()} [${cfg.me}] Released`);
      console.log(`${shortRef(item.id)}: unclaimed`);
      break;
    }
    case "done": {
      const item = resolveItem(cfg, ref);
      setSingleSelect(cfg, item.id, "Status", cfg.doneStatus);
      console.log(`${shortRef(item.id)} -> ${cfg.doneStatus}`);
      break;
    }
    case "archive": {
      const item = resolveItem(cfg, ref);
      archiveItem(cfg, item.id);
      console.log(`${shortRef(item.id)}: archived`);
      break;
    }
    case "status": {
      const status = opts.status ?? text;
      if (!status) {
        fail('status needs an option name: status <ref> "Bugs/Issues"');
      }
      const item = resolveItem(cfg, ref);
      setSingleSelect(cfg, item.id, "Status", status);
      console.log(`${shortRef(item.id)} -> ${status}`);
      break;
    }
    case "priority": {
      const priority = opts.priority ?? text;
      if (!priority) {
        fail('priority needs a level: priority <ref> "P0"');
      }
      const item = resolveItem(cfg, ref);
      setSingleSelect(cfg, item.id, "Priority", priority);
      console.log(`${shortRef(item.id)} -> ${priority}`);
      break;
    }
    case "due": {
      const date = opts.due ?? text;
      if (!date) fail('due needs a date: due <ref> "2026-10-01"');
      const item = resolveItem(cfg, ref);
      setDate(cfg, item.id, "End date", date);
      console.log(`${shortRef(item.id)} -> due ${date}`);
      break;
    }
    case "note": {
      if (!text) {
        fail('note needs text: note <ref> "what changed / what is next"');
      }
      const item = resolveItem(cfg, ref);
      const draftId = requireDraft(item, "append to its Log");
      writeLogLine(draftId, `- ${timestamp()} [${cfg.me}] ${text}`);
      console.log(`Noted on ${shortRef(item.id)}.`);
      break;
    }
    case "link": {
      if (!text) fail("link needs a URL: link <ref> <pr-url>");
      const item = resolveItem(cfg, ref);
      setText(cfg, item.id, "Link", text);
      const draftId = requireDraft(item, "record this in its Log");
      writeLogLine(draftId, `- ${timestamp()} [${cfg.me}] Linked ${text}`);
      console.log(`Linked ${shortRef(item.id)} -> ${text}`);
      break;
    }
    default:
      fail(`Unknown command '${command}'. Run: node scripts/tasks.mjs help`);
  }
}

try {
  main();
} catch (error) {
  // One clean line on stderr and a non-zero exit, so agents can read the reason.
  const known =
    error instanceof TaskError || error.code?.startsWith("ERR_PARSE_ARGS");
  console.error(`tasks: ${known ? error.message : error.stack}`);
  process.exitCode = 1;
}

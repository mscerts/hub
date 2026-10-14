import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  CheckError,
  FAILED_ISSUE_TITLE,
  ISSUE_LABEL,
  ISSUE_TITLE,
  KINDS,
  MICROSOFT_OWNERS,
  RateLimitError,
  applyIgnore,
  buildHeadline,
  buildReport,
  carryForward,
  checkRepo,
  codePattern,
  daysBetween,
  decideIssueAction,
  diffItems,
  emptyTracker,
  extractReferences,
  extractUrls,
  findCandidates,
  findReadmeHint,
  groupLocations,
  isLocalised,
  isRealIsoDate,
  listOrgRepos,
  loadConfig,
  loadHubExams,
  loadIgnore,
  loadRelatedExams,
  loadTracker,
  makeClient,
  newRepoFinding,
  nextLink,
  normalizeTracker,
  ownerClass,
  parseRepoUrl,
  repoLink,
  run,
  safeText,
  stripComments,
  summarizeOwners,
  syncFailureIssue,
  syncIssue,
  syncStateIssue,
  trackerContent,
} from "../../scripts/lab-repos-check.mjs";
import { listOpenIssues } from "../../scripts/lib/gh.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "lab-repos-check.mjs");
const workflowFile = join(root, ".github", "workflows", "lab-repos-check.yml");

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "lab-repos-"));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Real README heads (checked live on 2026-10-14)
// ---------------------------------------------------------------------------
const README_AZ400 = `> ⚠️ **Notice**
> This repository will be **archived on November 14, 2025**.
> The new repository for DevOps labs can be found here: [MicrosoftLearning/mslearn-devops](https://github.com/MicrosoftLearning/mslearn-devops)

# AZ-400: Designing and Implementing Microsoft DevOps Solutions

## Welcome

This repository is for instructors teaching Microsoft courses. If you are in class, please ask your instructor for assistance.

- **[Link to labs (HTML format)](https://microsoftlearning.github.io/AZ400-DesigningandImplementingMicrosoftDevOpsSolutions/)**
- **Are you a MCT?** - Have a look at our [GitHub User Guide for MCTs](https://microsoftlearning.github.io/MCT-User-Guide/)
- **[Download Latest Student Handbook and AllFiles Content](../../releases/latest)**
- **Need to manually build the lab instructions?** - Instructions are available in the [MicrosoftLearning/Docker-Build](https://github.com/MicrosoftLearning/Docker-Build) repository
`;

const README_AI_SERVICES = `# Develop AI Solutions in Azure

> **NOTE**: This repo is being archived, and is no longer maintained. Please visit the [generative AI apps](https://learn.microsoft.com/en-us/training/paths/create-custom-copilots-ai-studio/) learning path and [associated lab repo](https://github.com/MicrosoftLearning/mslearn-ai-studio), or [Azure AI Foundry documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/)

The exercises in this repo are designed to provide you with a hands-on learning experience.
`;

const README_AZ800 = `**This course will be retired on 2026-9-30. Once course is retired, all GitHub repos will be removed. Thank you!**

# AZ-800T00: Administering Windows Server Hybrid Core Infrastructure

- **[Download Latest Student Handbook and AllFiles Content](../../releases/latest)**
`;

// AZ-140 says two legacy tracks are unmaintained: not a notice about the repository
const README_AZ140 = `# AZ-140: Configuring and Operating Microsoft Azure Virtual Desktop

> Important: The following two tracks are no longer maintained or supported (instructions for this lab are located in the Instructions -> Labs_Legacy directory)

- **[Link to labs (HTML format)](https://microsoftlearning.github.io/AZ-140-Configuring-and-Operating-Microsoft-Azure-Virtual-Desktop/)**
`;

const README_PLAIN = `# AZ-104 Labs

This repository is for instructors teaching Microsoft courses.
Please use the lab instructions in the Instructions folder.
`;

// ---------------------------------------------------------------------------
// Dates, text
// ---------------------------------------------------------------------------
test("dates must be real YYYY-MM-DD days and are counted in whole UTC days", () => {
  assert.ok(isRealIsoDate("2026-10-14"));
  assert.ok(!isRealIsoDate("2026-02-31"));
  assert.ok(!isRealIsoDate("2026-10-14T00:00:00Z"));
  assert.ok(!isRealIsoDate(undefined));
  assert.equal(daysBetween("2026-10-07", "2026-10-14"), 7);
  assert.equal(daysBetween("2026-12-30", "2027-01-02"), 3);
});

test("text taken from GitHub cannot ping, link an issue or inject HTML, and a bad name is inert", () => {
  const text = safeText("x @everyone fixes #123 <img src=x onerror=1> `a` | b");
  assert.ok(!text.includes("<") && !text.includes(">") && !text.includes("`"));
  assert.ok(!text.includes("|"));
  assert.ok(!/@everyone/.test(text), "the @ is followed by a zero-width space");
  assert.ok(!/#123/.test(text));
  assert.equal(
    repoLink("MicrosoftLearning/mslearn-devops"),
    "[MicrosoftLearning/mslearn-devops](https://github.com/MicrosoftLearning/mslearn-devops)",
  );
  const inert = repoLink("evil/<script>[x](http://e)");
  assert.ok(!inert.startsWith("[") && !inert.includes("<"), inert);
});

// ---------------------------------------------------------------------------
// URL parsing and extraction
// ---------------------------------------------------------------------------
test("repository references are read from github.com, github.io and raw links only", () => {
  const ok = (url, expected) =>
    assert.deepEqual(parseRepoUrl(url), expected, url);
  ok("https://github.com/MicrosoftLearning/mslearn-devops", {
    owner: "MicrosoftLearning",
    repo: "mslearn-devops",
    via: "repo",
  });
  ok("https://github.com/MicrosoftLearning/mslearn-devops/blob/main/a/b.md#x", {
    owner: "MicrosoftLearning",
    repo: "mslearn-devops",
    via: "repo",
  });
  ok("https://github.com/MicrosoftLearning/mslearn-devops.git", {
    owner: "MicrosoftLearning",
    repo: "mslearn-devops",
    via: "repo",
  });
  ok("https://www.github.com/a/b", { owner: "a", repo: "b", via: "repo" });
  ok("https://github.com/github/copilot-cli-for-beginners", {
    owner: "github",
    repo: "copilot-cli-for-beginners",
    via: "repo",
  });
  ok("https://microsoftlearning.github.io/AZ-104/Instructions/Labs/x.html", {
    owner: "microsoftlearning",
    repo: "AZ-104",
    via: "pages",
  });
  ok("https://microsoft.github.io/", {
    owner: "microsoft",
    repo: "microsoft.github.io",
    via: "pages",
  });
  ok("https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh", {
    owner: "nvm-sh",
    repo: "nvm",
    via: "raw",
  });

  for (const nope of [
    "https://github.com/MicrosoftLearning",
    "https://github.com/features/copilot",
    "https://github.com/pricing",
    "https://github.com/sponsors/someone",
    "https://github.com/orgs/MicrosoftLearning/repositories?q=az",
    "https://education.github.com/pack",
    "https://gist.github.com/a/b",
    "https://a.b.github.io/x",
    "https://github.com/-bad/repo",
    "https://github.com/a/b%c",
    "https://example.com/github.com/a/b",
    "not a url",
  ]) {
    assert.equal(parseRepoUrl(nope), null, nope);
  }
});

test("URLs are found in markdown, JSX and prose with trailing punctuation removed", () => {
  const text = [
    "see [x](https://github.com/a/b).",
    '<LinkCard href="https://github.com/c/d/" />',
    'href={"https://github.com/e/f"}',
    "**https://github.com/g/h**, and https://github.com/i/j;",
  ].join("\n");
  assert.deepEqual(
    extractUrls(text).map((u) => [u.url, u.line]),
    [
      ["https://github.com/a/b", 1],
      ["https://github.com/c/d/", 2],
      ["https://github.com/e/f", 3],
      ["https://github.com/g/h", 4],
      ["https://github.com/i/j", 4],
    ],
  );
});

test("comments are removed but the line numbers stay true", () => {
  const source = [
    "line 1",
    "{/* https://github.com/x/commented",
    "   still a comment */}",
    "line 4 https://github.com/x/real",
    "<!-- https://github.com/x/html -->",
    "line 6 https://github.com/x/real2",
  ].join("\n");
  const stripped = stripComments(source);
  assert.equal(stripped.split("\n").length, source.split("\n").length);
  assert.deepEqual(
    extractUrls(stripped).map((u) => [u.url, u.line]),
    [
      ["https://github.com/x/real", 4],
      ["https://github.com/x/real2", 6],
    ],
  );
});

async function makeDocs(files) {
  const dir = await tempDir();
  const docsDir = join(dir, "docs");
  for (const [rel, content] of Object.entries(files)) {
    const file = join(docsDir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    dir,
    docsDir,
    trackerFile: join(dir, "tracker.json"),
    ignoreFile: join(dir, "ignore.json"),
    reportFile: join(dir, "report.md"),
    errorFile: join(dir, "error.md"),
    outputFile: join(dir, "output"),
    summaryFile: join(dir, "summary.md"),
  };
}

const page = (...lines) => `---\ntitle: t\n---\n${lines.join("\n")}\n`;

test("references are grouped per repository whatever the casing, with file and line", async () => {
  const docs = await makeDocs({
    "azure/AZ-104.mdx": page("exam"),
    "labs/azure/az-104.mdx": page(
      "{/* https://github.com/MicrosoftLearning/ignored-comment */}",
      "https://microsoftlearning.github.io/AZ-104-Admin/Instructions/Labs/a.html",
      "https://microsoftlearning.github.io/AZ-104-Admin/Instructions/Labs/b.html",
      "https://github.com/MicrosoftLearning/az-104-admin",
      "https://github.com/features/copilot https://github.com/arvigeus/AZ-204",
    ),
    "guide/x.md": "[hub](https://github.com/mscerts/hub)\n",
    "labs/_draft.mdx": "https://github.com/MicrosoftLearning/underscore\n",
  });
  const { refs, fileCount } = extractReferences(docs.docsDir);
  assert.equal(fileCount, 3, "files starting with _ are skipped");
  assert.deepEqual([...refs.keys()].sort(), [
    "arvigeus/az-204",
    "microsoftlearning/az-104-admin",
    "mscerts/hub",
  ]);
  const admin = refs.get("microsoftlearning/az-104-admin");
  assert.equal(admin.locations.length, 3);
  assert.deepEqual(
    admin.locations.map((l) => [l.file, l.line]),
    [
      // three frontmatter lines, then the comment on line 4
      ["src/content/docs/labs/azure/az-104.mdx", 5],
      ["src/content/docs/labs/azure/az-104.mdx", 6],
      ["src/content/docs/labs/azure/az-104.mdx", 7],
    ],
  );
  assert.deepEqual([...admin.vias].sort(), ["pages", "repo"]);
  assert.equal(
    admin.display,
    "MicrosoftLearning/az-104-admin",
    "the casing of a github.com link wins over the lowercase github.io host",
  );
  assert.equal(admin.ownerClass, "microsoft");
  assert.equal(refs.get("mscerts/hub").ownerClass, "hub");
  assert.equal(refs.get("arvigeus/az-204").ownerClass, "third-party");
  assert.deepEqual(groupLocations(admin.locations), [
    {
      file: "src/content/docs/labs/azure/az-104.mdx",
      firstLine: 5,
      count: 3,
    },
  ]);
  assert.deepEqual(
    summarizeOwners(refs).map((o) => [o.owner.toLowerCase(), o.repos]),
    [
      ["arvigeus", 1],
      ["microsoftlearning", 1],
      ["mscerts", 1],
    ],
  );
});

test("owners are classified: Microsoft-owned, the hub's own, or third-party", () => {
  for (const owner of [
    "MicrosoftLearning",
    "microsoft",
    "Azure",
    "Azure-Samples",
    "MicrosoftDocs",
    "github",
    "PowerShell",
    "dotnet",
    "MicrosoftGraph",
    "microsoft-something-new",
  ]) {
    assert.equal(ownerClass(owner), "microsoft", owner);
  }
  assert.equal(ownerClass("mscerts"), "hub");
  for (const owner of ["arvigeus", "timothywarner-org", "nvm-sh", "Schniz"]) {
    assert.equal(ownerClass(owner), "third-party", owner);
  }
  assert.ok(MICROSOFT_OWNERS.has("microsoftlearning"));
});

test("the real content yields a plausible reference set", () => {
  const docsDir = join(root, "src", "content", "docs");
  const { refs, fileCount } = extractReferences(docsDir);
  assert.ok(fileCount > 100, `${fileCount} pages`);
  assert.ok(refs.size >= 30, `${refs.size} repositories`);
  assert.ok(
    [...refs.values()].some((ref) => ref.ownerClass === "microsoft"),
    "Microsoft-owned repositories are linked",
  );
  for (const ref of refs.values()) {
    assert.ok(ref.locations.length > 0);
    for (const loc of ref.locations) {
      assert.ok(existsSync(join(root, loc.file)), loc.file);
      assert.ok(loc.line >= 1);
    }
  }
  const exams = loadHubExams(docsDir);
  assert.ok(exams.has("AZ-104") && exams.size >= 30);
  assert.equal(exams.get("AZ-104").area, "azure");
});

// ---------------------------------------------------------------------------
// Hub exam codes in repository names
// ---------------------------------------------------------------------------
test("a hub exam code is found in a repository name, with or without the hyphen, never inside another number", () => {
  const yes = (code, name) =>
    assert.ok(codePattern(code).test(name), `${code} in ${name}`);
  const no = (code, name) =>
    assert.ok(!codePattern(code).test(name), `${code} not in ${name}`);
  yes("AZ-400", "AZ400-DesigningandImplementingMicrosoftDevOpsSolutions");
  yes("AZ-400", "az-400-labs");
  yes("AB-650", "AB-650T00_administer_microsoft_365_and_ai_services");
  yes("AB-620", "AB-620T00_build_integrated_ai_agents_in_copilot_studio");
  yes(
    "AZ-700",
    "AZ-700-Designing-and-Implementing-Microsoft-Azure-Networking-Solutions",
  );
  yes("SC-100", "mslearn-SC-100");
  no("AZ-400", "AZ-4000-extra");
  no("AB-650", "AB-6500");
  no("AZ-400", "XAZ-400");
  no("AZ-104", "AZ-1040");
  no("AB-400", "PL-400-power-platform");
});

test("localised and broken copies are not candidates", () => {
  for (const name of [
    "AZ-802-Windows-Server-Administrator-Associate.ja-jp",
    "mslearn-sec-identity.ja-JP",
    "x.zh-TW",
    "x.pt-br",
    "https-github.com-MicrosoftLearning-AZ-900-Microsoft-Azure-Fundamentals.ja-jp",
  ]) {
    assert.ok(isLocalised(name), name);
  }
  for (const name of [
    "AZ-104-MicrosoftAzureAdministrator",
    "mslearn-ai-ml",
    "tool.js",
    "AB-650T00_administer_microsoft_365_and_ai_services",
  ]) {
    assert.ok(!isLocalised(name), name);
  }
});

test("candidates are the non-localised, public repositories that carry a hub exam code", () => {
  const exams = new Map(
    ["AB-650", "AZ-400", "AZ-800", "AZ-801", "SC-100"].map((code) => [
      code,
      { code, area: "azure", examPath: `p/${code}.mdx`, labPath: null },
    ]),
  );
  const item = (name, extra = {}) => ({
    name,
    full_name: `MicrosoftLearning/${name}`,
    archived: false,
    disabled: false,
    private: false,
    has_pages: true,
    fork: false,
    created_at: "2026-09-22T10:00:00Z",
    pushed_at: "2026-10-08T10:00:00Z",
    description: "labs @everyone #12 <b>x</b>",
    ...extra,
  });
  const found = findCandidates(
    [
      item("AB-650T00_administer_microsoft_365_and_ai_services"),
      item("AZ-800-AZ-801-merged"),
      item("AZ-800-Administering.ja-jp"),
      item("https-github.com-MicrosoftLearning-AB-650T00_x.ja-jp"),
      item("AZ-400-private", { private: true }),
      item("mslearn-ai-fundamentals"),
      item("SC-100-Microsoft-Cybersecurity-Architect", { archived: true }),
    ],
    exams,
  );
  assert.deepEqual(
    found.map((c) => [c.fullName, c.codes, c.archived]),
    [
      [
        "MicrosoftLearning/AB-650T00_administer_microsoft_365_and_ai_services",
        ["AB-650"],
        false,
      ],
      ["MicrosoftLearning/AZ-800-AZ-801-merged", ["AZ-800", "AZ-801"], false],
      [
        "MicrosoftLearning/SC-100-Microsoft-Cybersecurity-Architect",
        ["SC-100"],
        true,
      ],
    ],
  );
  assert.equal(found[0].createdAt, "2026-09-22");
  assert.ok(!/@everyone|<b>|#12/.test(found[0].description));
});

test("exams a page links or a retiring exam names as its replacement are watched too, once", async () => {
  const docs = await makeDocs({
    "power/PL-400.mdx": page(
      "PL-400 is transitioning to [AB-400](https://learn.microsoft.com/credentials/certifications/exams/ab-400?WT.mc_id=x)",
      "own exam [PL-400](https://learn.microsoft.com/credentials/certifications/exams/pl-400)",
      "{/* [AZ-999](https://learn.microsoft.com/credentials/certifications/exams/az-999) */}",
    ),
    "security/SC-500.mdx": page(
      "https://learn.microsoft.com/credentials/certifications/exams/az-500 and again ab-400",
      "https://learn.microsoft.com/credentials/certifications/exams/ab-4000",
    ),
    "azure/AZ-800.mdx": page("retiring"),
  });
  const retiring = join(docs.dir, "retiring.json");
  writeFileSync(
    retiring,
    JSON.stringify({
      exams: [
        { code: "AZ-800", replacementCode: "AZ-802" },
        { code: "MS-102", replacementCode: "ab-650" },
        { code: "X-1", replacementCode: "not a code" },
        { code: "AZ-801" },
      ],
    }),
  );
  const hub = loadHubExams(docs.docsDir);
  assert.deepEqual([...hub.keys()].sort(), ["AZ-800", "PL-400", "SC-500"]);
  const related = loadRelatedExams(docs.docsDir, hub, retiring);
  assert.deepEqual([...related.keys()].sort(), [
    "AB-400",
    "AB-650",
    "AZ-500",
    "AZ-802",
  ]);
  assert.equal(
    related.get("AB-400").namedOn,
    "src/content/docs/power/PL-400.mdx:4",
    "the first place that names it",
  );
  assert.equal(
    related.get("AZ-500").namedOn,
    "src/content/docs/security/SC-500.mdx:4",
  );
  assert.equal(
    related.get("AZ-802").namedOn,
    "src/data_files/retiring-exams.json (replaces AZ-800)",
  );
  assert.deepEqual(
    { ...related.get("AB-400"), namedOn: undefined },
    {
      code: "AB-400",
      area: null,
      examPath: null,
      labPath: null,
      namedOn: undefined,
    },
  );

  // a missing or corrupt retiring-exams.json only drops that source
  assert.deepEqual(
    [
      ...loadRelatedExams(
        docs.docsDir,
        hub,
        join(docs.dir, "nope.json"),
      ).keys(),
    ].sort(),
    ["AB-400", "AZ-500"],
  );
  writeFileSync(retiring, "{ nope");
  assert.deepEqual(
    [...loadRelatedExams(docs.docsDir, hub, retiring).keys()].sort(),
    ["AB-400", "AZ-500"],
  );
});

// ---------------------------------------------------------------------------
// README hints and successors
// ---------------------------------------------------------------------------
test("a README notice names the successor, and only the repositories next to the notice", () => {
  const hint = findReadmeHint(
    README_AZ400,
    "microsoftlearning/az400-designingandimplementingmicrosoftdevopssolutions",
  );
  assert.ok(hint);
  assert.match(hint.text, /will be archived on November 14, 2025/);
  assert.deepEqual(
    hint.successors.map((s) => s.display),
    ["MicrosoftLearning/mslearn-devops"],
    "Docker-Build and the MCT guide are not successors",
  );

  const services = findReadmeHint(
    README_AI_SERVICES,
    "microsoftlearning/mslearn-ai-services",
  );
  assert.deepEqual(
    services.successors.map((s) => s.display),
    ["MicrosoftLearning/mslearn-ai-studio"],
    "a Microsoft Learn link is not a repository",
  );

  const retired = findReadmeHint(README_AZ800, "microsoftlearning/az-800");
  assert.match(retired.text, /course will be retired on 2026-9-30/);
  assert.deepEqual(retired.successors, []);
});

test("a README without a replacement notice is not a notice, including legacy tracks and a bare 'please use'", () => {
  assert.equal(findReadmeHint(README_AZ140, "microsoftlearning/az-140"), null);
  assert.equal(findReadmeHint(README_PLAIN, "microsoftlearning/az-104"), null);
  assert.equal(findReadmeHint("", "a/b"), null);
  // only the head of the README counts
  const late = `${"line\n".repeat(80)}This repo is archived.\n`;
  assert.equal(findReadmeHint(late, "a/b", 60), null);
  assert.ok(findReadmeHint(late, "a/b", 100));
  // the repository itself is never its own successor
  const self = findReadmeHint(
    "This repository has been archived. See https://github.com/Owner/Repo and https://github.com/Owner/Other",
    "owner/repo",
  );
  assert.deepEqual(
    self.successors.map((s) => s.display),
    ["Owner/Other"],
  );
  // prose can not carry markup into the issue
  const hostile = findReadmeHint(
    "This repo will be archived @everyone <script>alert(1)</script> #123\n",
    "a/b",
  );
  assert.ok(!/<|>|@everyone|#123/.test(hostile.text));
});

// ---------------------------------------------------------------------------
// The GitHub client
// ---------------------------------------------------------------------------
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientCfg(fetchFn, extra = {}) {
  const slept = [];
  const cfg = loadConfig(
    {
      GH_TOKEN: "test-token",
      REQUEST_DELAY_MS: "0",
      RETRY_BASE_MS: "10",
      MAX_RETRY_AFTER_MS: "5000",
      TODAY: "2026-10-14",
      ...extra,
    },
    {
      fetch: fetchFn,
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  );
  return { cfg, slept };
}

test("requests carry the token and the API headers, and 5xx answers and network errors are retried", async () => {
  const seen = [];
  let calls = 0;
  const { cfg, slept } = clientCfg(async (url, options) => {
    seen.push({ url, headers: options.headers });
    calls += 1;
    if (calls === 1) return new Response("bad gateway", { status: 502 });
    if (calls === 2) throw new Error("socket hang up");
    return json({ full_name: "a/b" });
  });
  const client = makeClient(cfg);
  const res = await client.get("/repos/a/b");
  assert.equal(res.status, 200);
  assert.equal(res.json.full_name, "a/b");
  assert.equal(seen.length, 3);
  assert.equal(seen[0].url, "https://api.github.com/repos/a/b");
  assert.equal(seen[0].headers.Authorization, "Bearer test-token");
  assert.equal(seen[0].headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.match(seen[0].headers["User-Agent"], /Mozilla/);
  assert.deepEqual(slept, [10, 20], "exponential backoff between attempts");
  assert.equal(client.stats.retries, 2);
});

test("a lookup that never gets an answer is status 0, not an error and not evidence", async () => {
  const { cfg } = clientCfg(async () => new Response("", { status: 503 }));
  const res = await makeClient(cfg).get("/repos/a/b");
  assert.equal(res.status, 0);
  assert.match(res.error, /503/);
});

test("a short rate limit is waited out, a long one stops the run, and a plain 403 is just a 403", async () => {
  let calls = 0;
  const waited = clientCfg(async () => {
    calls += 1;
    return calls === 1
      ? json({ message: "rate limit" }, 403, { "retry-after": "2" })
      : json({ full_name: "a/b" });
  });
  const res = await makeClient(waited.cfg).get("/repos/a/b");
  assert.equal(res.status, 200);
  assert.deepEqual(waited.slept, [2000]);

  const long = clientCfg(async () =>
    json({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3000),
    }),
  );
  await assert.rejects(
    makeClient(long.cfg).get("/repos/a/b"),
    (error) =>
      error instanceof RateLimitError && /rate limit/i.test(error.message),
  );

  const tooMany = clientCfg(async () => json({ message: "slow down" }, 429));
  await assert.rejects(
    makeClient(tooMany.cfg).get("/repos/a/b"),
    RateLimitError,
  );

  const plain = clientCfg(async () =>
    json({ message: "Resource not accessible by integration" }, 403),
  );
  assert.equal((await makeClient(plain.cfg).get("/repos/a/b")).status, 403);
});

test("a blocked repository is 451, a rejected token stops the run, and the token never leaves the API origin", async () => {
  const blocked = clientCfg(async () =>
    json(
      { message: "Repository access blocked", block: { reason: "dmca" } },
      403,
    ),
  );
  assert.equal((await makeClient(blocked.cfg).get("/repos/a/b")).status, 451);

  const rejected = clientCfg(async () =>
    json({ message: "Bad credentials" }, 401),
  );
  await assert.rejects(
    makeClient(rejected.cfg).get("/repos/a/b"),
    (error) =>
      error instanceof CheckError && /rejected the token/.test(error.message),
  );

  let called = false;
  const guarded = clientCfg(async () => {
    called = true;
    return json({});
  });
  await assert.rejects(
    makeClient(guarded.cfg).get("https://evil.example/repos/a/b"),
    /Refusing to send the GitHub token/,
  );
  assert.equal(called, false);
});

test("the Link header is followed, and the organisation listing is deduplicated and validated", async () => {
  assert.equal(
    nextLink(
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
    ),
    "https://api.github.com/x?page=2",
  );
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);

  const item = (name) => ({ name, full_name: `Org/${name}` });
  const pages = {
    1: [item("a"), item("b")],
    2: [item("b"), item("c")],
  };
  const { cfg } = clientCfg(async (url) => {
    const page = new URL(url).searchParams.get("page") ?? "1";
    return json(
      pages[page],
      200,
      page === "1"
        ? { link: '<https://api.github.com/orgs/Org/repos?page=2>; rel="next"' }
        : {},
    );
  });
  const listed = await listOrgRepos(makeClient(cfg), "Org");
  assert.deepEqual(listed.map((r) => r.name).sort(), ["a", "b", "c"]);

  const missing = clientCfg(async () => json({ message: "Not Found" }, 404));
  await assert.rejects(
    listOrgRepos(makeClient(missing.cfg), "Org"),
    /organisation Org was not found/,
  );
  const odd = clientCfg(async () => json([{ nope: 1 }]));
  await assert.rejects(
    listOrgRepos(makeClient(odd.cfg), "Org"),
    /without name/,
  );
  const broken = clientCfg(async () => json({ not: "a list" }));
  await assert.rejects(listOrgRepos(makeClient(broken.cfg), "Org"), CheckError);
});

// ---------------------------------------------------------------------------
// Checking one linked repository
// ---------------------------------------------------------------------------
function ref(display, { vias = ["repo"], cls } = {}) {
  const [owner, repo] = display.split("/");
  return {
    key: display.toLowerCase(),
    owner,
    repo,
    display,
    ownerClass: cls ?? ownerClass(owner),
    vias: new Set(vias),
    locations: [
      { file: "src/content/docs/labs/azure/az-104.mdx", line: 3, url: "u" },
    ],
  };
}

/** A fetch that answers from a table of path -> response and records the paths asked. */
function routed(table) {
  const asked = [];
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const hit = table[path];
    if (hit === undefined) return json({ message: "Not Found" }, 404);
    // a Response body can be read once: a table may serve several clients
    return typeof hit === "function" ? hit() : hit.clone();
  };
  return { fetchFn, asked };
}

const repoJson = (full, extra = {}) =>
  json({
    full_name: full,
    archived: false,
    disabled: false,
    has_pages: true,
    pushed_at: "2026-10-01T00:00:00Z",
    ...extra,
  });
const text = (body, status = 200) => new Response(body, { status });

test("a missing repository is gone", async () => {
  const { fetchFn } = routed({});
  const { cfg } = clientCfg(fetchFn);
  const result = await checkRepo(makeClient(cfg), ref("Azure/Gone-Repo"), cfg);
  assert.equal(result.status, "checked");
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.repo, f.detail.code]),
    [["gone", "Azure/Gone-Repo", 404]],
  );
});

test("an archived first-party repository carries its README notice and suggested successors, with their state", async () => {
  const { fetchFn, asked } = routed({
    "/repos/MicrosoftLearning/AZ400-X": repoJson("MicrosoftLearning/AZ400-X", {
      archived: true,
      pushed_at: "2025-11-13T10:00:00Z",
    }),
    "/repos/MicrosoftLearning/AZ400-X/readme": text(README_AZ400),
    "/repos/MicrosoftLearning/mslearn-devops": repoJson(
      "MicrosoftLearning/mslearn-devops",
    ),
  });
  const { cfg } = clientCfg(fetchFn);
  const result = await checkRepo(
    makeClient(cfg),
    ref("MicrosoftLearning/AZ400-X", { vias: ["pages"] }),
    cfg,
  );
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["archived"],
    "one finding: the notice is part of the archived one",
  );
  const f = result.findings[0];
  assert.equal(f.detail.pushedAt, "2025-11-13");
  assert.match(f.detail.hint, /will be archived/);
  assert.deepEqual(f.detail.successors, [
    { repo: "MicrosoftLearning/mslearn-devops", state: "ok" },
  ]);
  assert.ok(asked.includes("/repos/MicrosoftLearning/mslearn-devops"));
});

test("a README notice on a repository that is not archived yet is a notice, and a plain README is nothing", async () => {
  const retiring = routed({
    "/repos/MicrosoftLearning/AZ-800": repoJson("MicrosoftLearning/AZ-800"),
    "/repos/MicrosoftLearning/AZ-800/readme": text(README_AZ800),
  });
  let { cfg } = clientCfg(retiring.fetchFn);
  const result = await checkRepo(
    makeClient(cfg),
    ref("MicrosoftLearning/AZ-800"),
    cfg,
  );
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["notice"],
  );
  assert.match(result.findings[0].detail.hint, /retired on 2026-9-30/);

  const plain = routed({
    "/repos/MicrosoftLearning/AZ-104": repoJson("MicrosoftLearning/AZ-104"),
    "/repos/MicrosoftLearning/AZ-104/readme": text(README_PLAIN),
  });
  ({ cfg } = clientCfg(plain.fetchFn));
  const clean = await checkRepo(
    makeClient(cfg),
    ref("MicrosoftLearning/AZ-104"),
    cfg,
  );
  assert.deepEqual(clean.findings, []);

  const noReadme = routed({
    "/repos/MicrosoftLearning/AZ-105": repoJson("MicrosoftLearning/AZ-105"),
  });
  ({ cfg } = clientCfg(noReadme.fetchFn));
  assert.deepEqual(
    (await checkRepo(makeClient(cfg), ref("MicrosoftLearning/AZ-105"), cfg))
      .findings,
    [],
    "a repository without a README is not a problem",
  );
});

test("a renamed repository is reported with its new name, a change of case only is not a rename", async () => {
  const renamed = routed({
    "/repos/MicrosoftLearning/Old-Name": repoJson("MicrosoftLearning/New-Name"),
    "/repos/MicrosoftLearning/New-Name/readme": text(README_PLAIN),
  });
  let { cfg } = clientCfg(renamed.fetchFn);
  const result = await checkRepo(
    makeClient(cfg),
    ref("MicrosoftLearning/Old-Name"),
    cfg,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.detail.renamedTo]),
    [["renamed", "MicrosoftLearning/New-Name"]],
  );

  const sameCase = routed({
    "/repos/microsoftlearning/az-104": repoJson("MicrosoftLearning/AZ-104"),
    "/repos/MicrosoftLearning/AZ-104/readme": text(README_PLAIN),
  });
  ({ cfg } = clientCfg(sameCase.fetchFn));
  assert.deepEqual(
    (await checkRepo(makeClient(cfg), ref("microsoftlearning/az-104"), cfg))
      .findings,
    [],
  );
});

test("Pages links into a repository without GitHub Pages, and a disabled repository, are problems", async () => {
  const table = {
    "/repos/MicrosoftLearning/NoPages": repoJson("MicrosoftLearning/NoPages", {
      has_pages: false,
      disabled: true,
    }),
    "/repos/MicrosoftLearning/NoPages/readme": text(README_PLAIN),
  };
  let { cfg } = clientCfg(routed(table).fetchFn);
  const viaPages = await checkRepo(
    makeClient(cfg),
    ref("MicrosoftLearning/NoPages", { vias: ["pages", "repo"] }),
    cfg,
  );
  assert.deepEqual(
    viaPages.findings.map((f) => f.kind),
    ["disabled", "no-pages"],
  );

  ({ cfg } = clientCfg(routed(table).fetchFn));
  const viaRepo = await checkRepo(
    makeClient(cfg),
    ref("MicrosoftLearning/NoPages", { vias: ["repo"] }),
    cfg,
  );
  assert.deepEqual(
    viaRepo.findings.map((f) => f.kind),
    ["disabled"],
    "no Pages problem when only the repository is linked",
  );
});

test("a third-party repository is only checked for gone and archived, and its README is not read", async () => {
  const routes = routed({
    "/repos/arvigeus/AZ-204": repoJson("arvigeus/AZ-204", {
      archived: true,
      has_pages: false,
    }),
    "/repos/Schniz/fnm": repoJson("Schniz/Renamed-Fnm", { has_pages: false }),
  });
  const { cfg } = clientCfg(routes.fetchFn);
  const archived = await checkRepo(
    makeClient(cfg),
    ref("arvigeus/AZ-204", { vias: ["pages"] }),
    cfg,
  );
  assert.deepEqual(
    archived.findings.map((f) => [f.kind, f.thirdParty]),
    [["archived", true]],
  );
  const renamed = await checkRepo(makeClient(cfg), ref("Schniz/fnm"), cfg);
  assert.deepEqual(
    renamed.findings,
    [],
    "a rename of a third-party repo is not judged",
  );
  assert.ok(
    !routes.asked.some((path) => path.endsWith("/readme")),
    "no README request for a third party",
  );
});

test("a page of the account's user site is not a missing repository: the page itself has to answer", async () => {
  const routes = routed({
    "/repos/microsoft/microsoft.github.io": repoJson(
      "microsoft/microsoft.github.io",
    ),
    "/repos/microsoft/microsoft.github.io/readme": text(README_PLAIN),
    "/some-page/": text("<html>a page of the user site</html>"),
  });
  const { cfg } = clientCfg(routes.fetchFn);
  const some = await checkRepo(
    makeClient(cfg),
    ref("microsoft/some-page", { vias: ["pages"] }),
    cfg,
  );
  assert.deepEqual(some.findings, []);
  assert.equal(some.status, "checked");
  assert.deepEqual(routes.asked, [
    "/repos/microsoft/some-page",
    "/repos/microsoft/microsoft.github.io",
    "/some-page/",
  ]);

  // but a missing project with a repo link is gone, and no fallback is tried
  const missing = routed({});
  const second = clientCfg(missing.fetchFn);
  const gone = await checkRepo(
    makeClient(second.cfg),
    ref("microsoft/gone", { vias: ["repo", "pages"] }),
    second.cfg,
  );
  assert.deepEqual(
    gone.findings.map((f) => f.kind),
    ["gone"],
  );
  assert.deepEqual(missing.asked, ["/repos/microsoft/gone"]);
});

test("the user site repository does not hide a project that is gone: PartnerResources answers 404 on microsoft.github.io", async () => {
  // Live on 2026-10-14: repos/microsoft/PartnerResources and
  // https://microsoft.github.io/PartnerResources/ both answer 404, while
  // microsoft/microsoft.github.io exists.
  const seen = [];
  const routes = routed({
    "/repos/microsoft/microsoft.github.io": repoJson(
      "microsoft/microsoft.github.io",
    ),
  });
  const { cfg } = clientCfg(async (url, options) => {
    seen.push({ url, headers: options.headers });
    return routes.fetchFn(url, options);
  });
  const result = await checkRepo(
    makeClient(cfg),
    ref("microsoft/PartnerResources", { vias: ["pages"] }),
    cfg,
  );
  assert.equal(result.status, "checked");
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.repo, f.detail]),
    [["gone", "microsoft/PartnerResources", { code: 404, page: true }]],
  );
  // The page is asked for at its own address, in lowercase host form, without the token.
  const page = seen.find((request) => !request.url.includes("/repos/"));
  assert.equal(page.url, "https://microsoft.github.io/PartnerResources/");
  assert.equal(page.headers.Authorization, undefined);
  assert.match(page.headers["User-Agent"], /Mozilla/);
  // The words of the report say what is wrong.
  const ctx = reportCtx();
  ctx.linkedFindings = [
    { ...result.findings[0], firstSeen: "2026-10-14", thirdParty: false },
  ];
  ctx.refs.set(
    "microsoft/partnerresources",
    ref("microsoft/PartnerResources", { vias: ["pages"] }),
  );
  assert.match(
    buildReport(ctx),
    /the repository does not exist and its GitHub Pages address returns HTTP 404 \(it is not a page of the account's user site either\)/,
  );
});

test("a page of the user site that cannot be asked proves nothing: the lookup is unknown, never gone", async () => {
  for (const [status, expected] of [
    [503, /answered HTTP 503/],
    [429, /answered HTTP 429/],
    [403, /answered HTTP 403/],
  ]) {
    const routes = routed({
      "/repos/microsoft/microsoft.github.io": repoJson(
        "microsoft/microsoft.github.io",
      ),
      "/some-page/": text("nope", status),
    });
    const { cfg } = clientCfg(routes.fetchFn);
    const result = await checkRepo(
      makeClient(cfg),
      ref("microsoft/some-page", { vias: ["pages"] }),
      cfg,
    );
    assert.equal(result.status, "unknown", String(status));
    assert.match(result.reason, expected);
  }
  // A network error is no answer either.
  const { cfg } = clientCfg(async (url) => {
    if (new URL(url).pathname === "/some-page/") throw new Error("reset");
    return new URL(url).pathname === "/repos/microsoft/microsoft.github.io"
      ? repoJson("microsoft/microsoft.github.io")
      : json({ message: "Not Found" }, 404);
  });
  const down = await checkRepo(
    makeClient(cfg),
    ref("microsoft/some-page", { vias: ["pages"] }),
    cfg,
  );
  assert.equal(down.status, "unknown");
  assert.match(down.reason, /reset/);
});

test("the page request is made without the token and only to a github.io address", async () => {
  const { cfg } = clientCfg(async () => text("ok"));
  const client = makeClient(cfg);
  for (const bad of [
    "https://evil.example/x/",
    "http://microsoft.github.io/x/",
    "https://github.io.evil.example/x/",
    "https://api.github.com/repos/a/b",
  ]) {
    await assert.rejects(client.getPage(bad), CheckError, bad);
  }
  assert.equal((await client.getPage("https://a.github.io/x/")).status, 200);
});

test("past the run deadline no request is made and every call answers 'no answer'", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let calls = 0;
  const { cfg } = clientCfg(
    async () => {
      calls += 1;
      t.mock.timers.tick(200_000);
      return json({ full_name: "a/b" });
    },
    { RUN_DEADLINE_MS: "500000" },
  );
  assert.equal(cfg.runDeadlineMs, 500_000);
  const client = makeClient(cfg);
  assert.equal(client.expired(), false);
  for (let i = 0; i < 3; i++) {
    assert.equal((await client.get("/repos/a/b")).status, 200);
  }
  assert.equal(client.expired(), true);
  const late = await client.get("/repos/a/b");
  assert.equal(late.status, 0);
  assert.match(
    late.error,
    /run deadline \(RUN_DEADLINE_MS=500000\) was reached/,
  );
  assert.equal((await client.getPage("https://a.github.io/x/")).status, 0);
  assert.equal(calls, 3, "nothing was requested after the deadline");
  assert.equal(loadConfig({}).runDeadlineMs, 600_000);
});

test("a failed lookup is unknown, never a finding", async () => {
  for (const response of [
    () => new Response("", { status: 502 }),
    () => json({ message: "Resource not accessible" }, 403),
    () => json({ unexpected: true }, 200),
    () => json({ full_name: "not a full name!!" }, 200),
  ]) {
    const { cfg } = clientCfg(async () => response());
    const result = await checkRepo(
      makeClient(cfg),
      ref("MicrosoftLearning/AZ-104"),
      cfg,
    );
    assert.equal(result.status, "unknown");
    assert.ok(result.reason);
  }
});

// ---------------------------------------------------------------------------
// Ignore list
// ---------------------------------------------------------------------------
test("the ignore list needs a reason and the problems it covers, and a missing file is empty", async () => {
  const dir = await tempDir();
  const file = join(dir, "ignore.json");
  assert.deepEqual(loadIgnore(file), []);

  const write = (value) => writeFileSync(file, JSON.stringify(value));
  write({
    ignored: [
      {
        repo: "MicrosoftLearning/mslearn-ai-services",
        problems: ["archived"],
        reason: "AI-103 still teaches it",
      },
      {
        repo: "microsoftlearning/MSLEARN-AI-SERVICES",
        problems: ["notice"],
        reason: "same repo, second entry",
      },
    ],
  });
  const loaded = loadIgnore(file);
  assert.equal(loaded.length, 1, "entries for one repository are merged");
  assert.deepEqual([...loaded[0].problems].sort(), ["archived", "notice"]);

  for (const [bad, pattern] of [
    [{}, /"ignored" list/],
    [{ ignored: [null] }, /not an object/],
    [
      { ignored: [{ repo: "nope", problems: ["gone"], reason: "r" }] },
      /owner\/name/,
    ],
    [{ ignored: [{ repo: "a/b", problems: ["gone"] }] }, /non-empty "reason"/],
    [
      { ignored: [{ repo: "a/b", problems: ["gone"], reason: "  " }] },
      /non-empty "reason"/,
    ],
    [{ ignored: [{ repo: "a/b", reason: "r" }] }, /problems/],
    [{ ignored: [{ repo: "a/b", problems: [], reason: "r" }] }, /problems/],
    [
      { ignored: [{ repo: "a/b", problems: ["boring"], reason: "r" }] },
      /problems/,
    ],
  ]) {
    write(bad);
    assert.throws(() => loadIgnore(file), pattern, JSON.stringify(bad));
  }
  writeFileSync(file, "{ nope");
  assert.throws(() => loadIgnore(file), /not valid JSON/);
});

test("an ignored problem is not reported, a worse one is, and unmatched entries are named", () => {
  const ignore = [
    {
      key: "a/archived",
      repo: "a/archived",
      problems: new Set(["archived"]),
      reasons: ["r"],
    },
    {
      key: "a/removed",
      repo: "a/removed",
      problems: new Set(["archived", "gone"]),
      reasons: ["r"],
    },
  ];
  const finding = (key, kind) => ({ key, kind, repo: key });
  const result = applyIgnore(
    [
      finding("a/archived", "archived"),
      finding("a/archived", "gone"),
      finding("b/other", "archived"),
    ],
    ignore,
  );
  assert.deepEqual(
    result.kept.map((f) => `${f.key}|${f.kind}`),
    ["a/archived|gone", "b/other|archived"],
  );
  assert.equal(result.ignored, 1);
  assert.deepEqual(result.unused, [
    { repo: "a/removed", kind: "archived" },
    { repo: "a/removed", kind: "gone" },
  ]);
});

// ---------------------------------------------------------------------------
// Tracker, diffs and the issue decision
// ---------------------------------------------------------------------------
test("the tracker is validated and written in a fixed order", async () => {
  const dir = await tempDir();
  const file = join(dir, "tracker.json");
  assert.deepEqual(loadTracker(file), emptyTracker());
  assert.deepEqual(
    normalizeTracker(
      JSON.parse(
        readFileSync(join(root, "src", "data_files", "lab-repos.json"), "utf8"),
      ),
    ),
    emptyTracker(),
    "the committed starting file is the empty state",
  );

  const valid = {
    lastSynced: "2026-10-14",
    baselineAt: "2026-10-14",
    baseline: ["b/b", "a/a", "a/a"],
    problems: {
      "z/z|archived": {
        key: "z/z",
        repo: "Z/z",
        kind: "archived",
        firstSeen: "2026-10-14",
        detail: {
          pushedAt: "2025-11-13",
          hint: "h",
          successors: [{ repo: "a/b", state: "ok", extra: "dropped" }],
        },
      },
      "a/a|gone": {
        key: "a/a",
        repo: "a/a",
        kind: "gone",
        firstSeen: "2026-10-01",
        detail: { code: 404 },
      },
    },
    reported: { lastReported: "2026-10-14", items: ["b|x", "a|y", "a|y"] },
  };
  const tracker = normalizeTracker(valid);
  assert.deepEqual(tracker.baseline, ["a/a", "b/b"]);
  assert.deepEqual(Object.keys(tracker.problems), ["a/a|gone", "z/z|archived"]);
  assert.deepEqual(tracker.reported.items, ["a|y", "b|x"]);
  assert.deepEqual(tracker.problems["z/z|archived"].detail.successors, [
    { repo: "a/b", state: "ok" },
  ]);
  writeFileSync(file, trackerContent(tracker));
  assert.deepEqual(loadTracker(file), tracker);

  const corrupt = (mutate, pattern) => {
    const copy = structuredClone(valid);
    mutate(copy);
    assert.throws(() => normalizeTracker(copy), pattern);
  };
  corrupt((t) => (t.lastSynced = "yesterday"), /lastSynced/);
  corrupt((t) => (t.baseline = "x"), /baseline/);
  corrupt((t) => delete t.problems, /problems/);
  corrupt(
    (t) => (t.problems["a/a|gone"].kind = "new-repo"),
    /not a problem of a linked repository/,
  );
  corrupt(
    (t) => (t.problems["a/a|gone"].key = "other"),
    /not a problem of a linked repository/,
  );
  corrupt((t) => delete t.problems["a/a|gone"].firstSeen, /firstSeen/);
  corrupt((t) => (t.problems["a/a|gone"].detail = []), /detail/);
  corrupt((t) => (t.reported = { items: [1] }), /reported/);
  assert.throws(() => normalizeTracker([]), /not an object/);
  writeFileSync(file, "{ nope");
  assert.throws(() => loadTracker(file), /invalid JSON/);
});

test("the change of the list is what was added and what is resolved", () => {
  assert.deepEqual(diffItems(["a|x", "b|y"], ["b|y", "c|z"]), {
    added: ["c|z"],
    resolved: ["a|x"],
  });
  assert.deepEqual(diffItems([], []), { added: [], resolved: [] });
});

test("the issue is created, commented on, left alone or closed according to one table", () => {
  const decide = (args) =>
    decideIssueAction({
      active: true,
      changed: false,
      reminderDue: false,
      forced: false,
      openCount: 0,
      ...args,
    });
  // nothing left
  assert.equal(decide({ active: false, openCount: 1 }), "close");
  assert.equal(decide({ active: false, openCount: 2 }), "close");
  assert.equal(decide({ active: false, openCount: 0 }), "none");
  // an issue is open
  assert.equal(
    decide({ openCount: 1 }),
    "none",
    "the same list is not repeated",
  );
  assert.equal(decide({ openCount: 1, changed: true }), "comment");
  assert.equal(decide({ openCount: 1, forced: true }), "comment");
  assert.equal(decide({ openCount: 1, reminderDue: true }), "none");
  // no issue is open
  assert.equal(decide({}), "none", "closed on purpose, not yet due");
  assert.equal(decide({ changed: true }), "create");
  assert.equal(decide({ reminderDue: true }), "create");
  assert.equal(decide({ forced: true }), "create");
});

test("a failed lookup keeps what the tracker knew about the repository", () => {
  const tracker = normalizeTracker({
    lastSynced: null,
    baselineAt: null,
    baseline: null,
    problems: {
      "a/a|archived": {
        key: "a/a",
        repo: "A/a",
        kind: "archived",
        firstSeen: "2026-10-01",
        detail: { hint: "h" },
      },
      "b/b|gone": {
        key: "b/b",
        repo: "b/b",
        kind: "gone",
        firstSeen: "2026-10-02",
      },
    },
  });
  const carried = carryForward(tracker, "a/a");
  assert.equal(carried.length, 1);
  assert.deepEqual(
    [
      carried[0].kind,
      carried[0].repo,
      carried[0].carried,
      carried[0].detail.hint,
    ],
    ["archived", "A/a", true, "h"],
  );
  assert.deepEqual(carryForward(tracker, "c/c"), []);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
function reportCtx(extra = {}) {
  const refs = new Map();
  const add = (display, locations, cls) => {
    const r = ref(display, { cls });
    r.locations = locations;
    refs.set(r.key, r);
    return r;
  };
  add("MicrosoftLearning/AZ400-X", [
    { file: "src/content/docs/labs/azure/az-400.mdx", line: 53, url: "u" },
    { file: "src/content/docs/labs/azure/az-400.mdx", line: 54, url: "u" },
    { file: "src/content/docs/azure/AZ-400.mdx", line: 12, url: "u" },
  ]);
  add("MicrosoftLearning/mslearn-devops", [
    { file: "src/content/docs/labs/azure/az-400.mdx", line: 30, url: "u" },
  ]);
  add("arvigeus/AZ-204", [
    { file: "src/content/docs/azure/AI-200.mdx", line: 21, url: "u" },
  ]);
  const hubExams = new Map([
    [
      "AB-650",
      {
        code: "AB-650",
        area: "aibusiness",
        examPath: "src/content/docs/aibusiness/AB-650.mdx",
        labPath: "src/content/docs/labs/aibusiness/ab-650.mdx",
      },
    ],
    [
      "SC-100",
      {
        code: "SC-100",
        area: "security",
        examPath: "src/content/docs/security/SC-100.mdx",
        labPath: null,
      },
    ],
  ]);
  const candidate = (fullName, codes) => ({
    fullName,
    key: fullName.toLowerCase(),
    codes,
    archived: false,
    createdAt: "2026-09-22",
    pushedAt: "2026-10-08",
    hasPages: true,
    description: "Lab @everyone",
  });
  return {
    cfg: loadConfig({ TODAY: "2026-10-14" }),
    today: "2026-10-14",
    refs,
    hubExams,
    linkedFindings: [
      {
        key: "microsoftlearning/az400-x",
        repo: "MicrosoftLearning/AZ400-X",
        kind: "archived",
        firstSeen: "2026-10-14",
        thirdParty: false,
        detail: {
          pushedAt: "2025-11-13",
          hint: "This repository will be archived",
          successors: [
            { repo: "MicrosoftLearning/mslearn-devops", state: "ok" },
          ],
        },
      },
      {
        key: "arvigeus/az-204",
        repo: "arvigeus/AZ-204",
        kind: "archived",
        firstSeen: "2026-10-14",
        thirdParty: true,
        detail: {},
      },
    ],
    newFindings: [
      newRepoFinding(
        candidate("MicrosoftLearning/AB-650T00_administer", ["AB-650"]),
      ),
      newRepoFinding(
        candidate("MicrosoftLearning/SC-100-Architect", ["SC-100"]),
        false,
      ),
    ],
    ownerSummary: [
      {
        owner: "MicrosoftLearning",
        ownerClass: "microsoft",
        repos: 2,
        links: 4,
      },
      { owner: "arvigeus", ownerClass: "third-party", repos: 1, links: 1 },
    ],
    ignoredCount: 0,
    orgCount: 374,
    baselineNote: "",
    ...extra,
  };
}

test("the report names the repository, what is wrong, where it is linked and what to do", () => {
  const report = buildReport(reportCtx());
  assert.match(report, /^## Lab repos: 2026-10-14/);
  assert.match(report, /### Linked repositories with a problem \(2\)/);
  assert.match(
    report,
    /\[MicrosoftLearning\/AZ400-X\]\(https:\/\/github\.com\/MicrosoftLearning\/AZ400-X\)/,
  );
  assert.match(report, /\*\*archived\*\*, read-only, last push 2025-11-13/);
  assert.ok(report.includes("`src/content/docs/azure/AZ-400.mdx:12`"));
  assert.ok(
    report.includes("`src/content/docs/labs/azure/az-400.mdx:53` (2 links)"),
  );
  assert.ok(
    report.includes(
      "(exists, not archived; already linked from `src/content/docs/labs/azure/az-400.mdx`)",
    ),
    "a successor the page already links is said to be linked",
  );
  assert.match(report, /suggested from the README, not verified/);
  assert.match(report, /third-party owner/);
  assert.match(report, /not looked for \(third-party owner\)/);
  assert.match(
    report,
    /### New repositories that look like labs of hub exams \(2\)/,
  );
  assert.ok(report.includes("`src/content/docs/labs/aibusiness/ab-650.mdx`"));
  assert.match(
    report,
    /none yet \(exam page `src\/content\/docs\/security\/SC-100\.mdx`\)/,
  );
  assert.match(report, /baselined, listed because of report_all/);
  assert.match(report, /lab-repos-ignore\.json/);
  assert.match(
    report,
    /"Lab Repo Check" runbook \(`docs\/monitors\/lab-repo-check\.md`\)/,
  );
  assert.ok(!/@everyone/.test(report), "description is neutralised");
});

test("the report keeps hostile text inert and stays inside the size limit", () => {
  const ctx = reportCtx();
  ctx.linkedFindings[0].detail.hint =
    "x @everyone fixes #123 <img src=x onerror=1> `a` | b";
  ctx.linkedFindings[0].repo = "evil/<b>x</b>";
  const report = buildReport(ctx);
  assert.ok(!/<img|<b>|@everyone|#123/.test(report));

  const many = reportCtx();
  const extra = [];
  for (let i = 0; i < 200; i++) {
    const key = `owner/repo-${i}`;
    many.refs.set(key, ref(`owner/repo-${i}`));
    extra.push({
      key,
      repo: `owner/repo-${i}`,
      kind: "gone",
      thirdParty: false,
      firstSeen: "2026-10-14",
      detail: { code: 404 },
    });
  }
  many.linkedFindings = extra;
  const long = buildReport(many);
  assert.match(long, /…and 140 more repositories/);
  assert.ok(long.length < 60_000, `${long.length} characters`);
  assert.match(
    buildHeadline({ today: "2026-10-14", linkedCount: 2, newCount: 1 }),
    /^Lab repos 2026-10-14: 2 linked repositories and 1 new repository$/,
  );
  assert.equal(
    buildHeadline({ today: "2026-10-14", linkedCount: 0, newCount: 0 }),
    "Lab repos 2026-10-14: all clear",
  );
});

// ---------------------------------------------------------------------------
// Issues through gh (stubbed)
// ---------------------------------------------------------------------------
function stubGh({ open = [], fail = {}, labels = [] } = {}) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    const command = args.slice(0, 2).join(" ");
    if (fail[command]) throw new Error(`gh ${command} failed on purpose`);
    if (command === "issue list") return JSON.stringify(open);
    if (command === "label list") {
      return JSON.stringify(labels.map((name) => ({ name })));
    }
    if (command === "issue create")
      return "https://github.com/mscerts/hub/issues/42";
    return "";
  };
  gh.calls = calls;
  gh.commands = () => calls.map((c) => c.args.slice(0, 2).join(" "));
  return gh;
}
const openIssue = (number, title) => ({ number, title });

test("listOpenIssues matches the exact title", () => {
  const gh = stubGh({
    open: [
      openIssue(9, ISSUE_TITLE),
      openIssue(3, ISSUE_TITLE),
      openIssue(4, "other"),
    ],
  });
  assert.deepEqual(
    listOpenIssues(gh, { title: ISSUE_TITLE, label: ISSUE_LABEL }).map(
      (i) => i.number,
    ),
    [3, 9],
  );
});

test("the state issue is created once, commented on when the list changes, closed when clean, and untouched when disabled", () => {
  const base = {
    report: "REPORT",
    commentBody: "COMMENT",
  };
  const cfgOn = loadConfig({ CREATE_ISSUES: "1", TODAY: "2026-10-14" });
  const plan = (extra) => ({
    ...base,
    plan: {
      active: true,
      changed: true,
      reminderDue: false,
      forced: false,
      ...extra,
    },
  });

  let gh = stubGh();
  let issue = syncStateIssue(cfgOn, gh, plan({}));
  assert.equal(issue.action, "created");
  assert.equal(issue.number, 42);
  assert.deepEqual(gh.commands(), [
    "issue list",
    "label create",
    "issue create",
  ]);
  const create = gh.calls[2].args;
  assert.equal(create[create.indexOf("--title") + 1], ISSUE_TITLE);
  assert.equal(create[create.indexOf("--label") + 1], "enhancement");
  assert.ok(!create.includes("--assignee"), "no assignee");
  assert.equal(gh.calls[2].input, "REPORT");

  gh = stubGh({ open: [openIssue(7, ISSUE_TITLE)] });
  issue = syncStateIssue(cfgOn, gh, plan({}));
  assert.equal(issue.action, "commented");
  assert.deepEqual(gh.commands(), ["issue list", "issue comment"]);
  assert.equal(gh.calls[1].input, "COMMENT");

  gh = stubGh({ open: [openIssue(7, ISSUE_TITLE)] });
  issue = syncStateIssue(cfgOn, gh, plan({ changed: false }));
  assert.equal(issue.action, "none");
  assert.deepEqual(gh.commands(), ["issue list"]);

  gh = stubGh({ open: [openIssue(7, ISSUE_TITLE), openIssue(8, ISSUE_TITLE)] });
  issue = syncStateIssue(cfgOn, gh, plan({ active: false }));
  assert.equal(issue.action, "closed");
  assert.deepEqual(issue.closed, [7, 8]);
  assert.match(gh.calls[1].args[4], /nothing left to review/);

  const cfgOff = loadConfig({ TODAY: "2026-10-14" });
  gh = stubGh();
  assert.equal(syncStateIssue(cfgOff, gh, plan({})).action, "skipped");
  assert.equal(
    syncStateIssue(
      loadConfig({ CREATE_ISSUES: "1", DRY_RUN: "1" }),
      gh,
      plan({}),
    ).action,
    "skipped",
  );
  assert.equal(
    syncStateIssue(cfgOff, gh, plan({ active: false })).action,
    "none",
  );
  assert.deepEqual(gh.calls, [], "nothing touched, not even read");
});

test("a failed lookup stops the run when the issue is needed and is only a warning when it only had to close", () => {
  const cfgOn = loadConfig({ CREATE_ISSUES: "1", TODAY: "2026-10-14" });
  const failing = stubGh({ fail: { "issue list": true } });
  assert.throws(
    () =>
      syncStateIssue(cfgOn, failing, {
        report: "R",
        plan: {
          active: true,
          changed: true,
          reminderDue: false,
          forced: false,
        },
      }),
    /issue list failed/,
  );
  const quiet = syncStateIssue(cfgOn, failing, {
    plan: { active: false, changed: false, reminderDue: false, forced: false },
  });
  assert.equal(quiet.action, "lookup-failed");

  const noCreate = stubGh({ fail: { "issue create": true } });
  assert.throws(
    () =>
      syncStateIssue(cfgOn, noCreate, {
        report: "R",
        plan: {
          active: true,
          changed: true,
          reminderDue: false,
          forced: false,
        },
      }),
    /issue create failed/,
  );
});

test("a label that cannot be created is forgiven only when it exists; any other failure stops the issue", () => {
  const cfgOn = loadConfig({ CREATE_ISSUES: "1", TODAY: "2026-10-14" });
  const plan = {
    report: "R",
    plan: { active: true, changed: true, reminderDue: false, forced: false },
  };
  // gh refuses to create a label that is there already: the issue is still created
  const exists = stubGh({
    fail: { "label create": true },
    labels: [ISSUE_LABEL],
  });
  assert.equal(syncStateIssue(cfgOn, exists, plan).action, "created");
  assert.deepEqual(exists.commands(), [
    "issue list",
    "label create",
    "label list",
    "issue create",
  ]);
  // a creation that fails for another reason is not swallowed, and no issue is opened without its label
  const broken = stubGh({ fail: { "label create": true } });
  assert.throws(
    () => syncStateIssue(cfgOn, broken, plan),
    /label create failed/,
  );
  assert.ok(!broken.commands().includes("issue create"));
  const failure = stubGh({ fail: { "label create": true } });
  assert.throws(
    () => syncFailureIssue(cfgOn, failure, "boom"),
    /label create failed/,
  );
});

test("the failure issue is one issue with a comment per failed run, closed by the next healthy run", () => {
  const cfg = loadConfig({
    CREATE_ISSUES: "1",
    TODAY: "2026-10-14",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "mscerts/hub",
    GITHUB_RUN_ID: "99",
  });
  let gh = stubGh();
  assert.equal(syncFailureIssue(cfg, gh, "boom").action, "created");
  assert.equal(
    gh.calls[2].args[gh.calls[2].args.indexOf("--title") + 1],
    FAILED_ISSUE_TITLE,
  );
  assert.equal(
    gh.calls[2].args[gh.calls[2].args.indexOf("--label") + 1],
    "bug",
  );
  assert.match(
    gh.calls[2].input,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/99/,
  );

  gh = stubGh({ open: [openIssue(5, FAILED_ISSUE_TITLE)] });
  assert.equal(syncFailureIssue(cfg, gh, "boom again").action, "commented");
  assert.match(
    gh.calls[1].input,
    /^The lab repo check failed again on 2026-10-14:/,
  );

  gh = stubGh({ open: [openIssue(5, FAILED_ISSUE_TITLE)] });
  assert.equal(syncFailureIssue(cfg, gh, null).action, "closed");

  assert.equal(
    syncIssue({ gh: stubGh(), enabled: false, active: true }).action,
    "skipped",
  );
});

// ---------------------------------------------------------------------------
// A fake GitHub API on localhost
// ---------------------------------------------------------------------------
/**
 * state.repos: { "owner/name": { body, readme, status, readmeStatus, failures } }
 * state.org:   { Org: [items] }  (page size state.pageSize)
 * state.log:   [{ path, auth }]
 */
async function fakeGithub(state) {
  state.log = [];
  state.pageSize ??= 100;
  // like the real API, repository names are looked up case-insensitively
  const lookup = (owner, name) => {
    const wanted = `${owner}/${name}`.toLowerCase();
    const key = Object.keys(state.repos).find(
      (k) => k.toLowerCase() === wanted,
    );
    return key === undefined ? undefined : state.repos[key];
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.log.push({
      path: url.pathname + url.search,
      auth: req.headers.authorization,
    });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let match = /^\/repos\/([^/]+)\/([^/]+)\/readme$/.exec(url.pathname);
    if (match) {
      const entry = lookup(match[1], match[2]);
      if (entry?.readme !== undefined) {
        res.writeHead(entry.readmeStatus ?? 200, {
          "content-type": "text/plain",
        });
        return res.end(entry.readme);
      }
      return send(404, { message: "Not Found" });
    }
    match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const entry = lookup(match[1], match[2]);
      if (!entry) return send(404, { message: "Not Found" });
      if (entry.failures?.length) {
        return send(entry.failures.shift(), { message: "boom" });
      }
      if (entry.status && entry.status !== 200) {
        return send(entry.status, entry.body ?? { message: "x" });
      }
      return send(200, entry.body);
    }
    match = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (match) {
      const items = state.org[match[1]];
      if (!items) return send(404, { message: "Not Found" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = items.slice(
        (page - 1) * state.pageSize,
        page * state.pageSize,
      );
      const headers = {};
      if (page * state.pageSize < items.length) {
        headers.link = `<${state.origin}/orgs/${match[1]}/repos?per_page=100&page=${page + 1}>; rel="next"`;
      }
      return send(200, slice, headers);
    }
    return send(404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

const repoBody = (full, extra = {}) => ({
  full_name: full,
  archived: false,
  disabled: false,
  has_pages: true,
  pushed_at: "2026-10-01T00:00:00Z",
  ...extra,
});
const orgItem = (name, extra = {}) => ({
  name,
  full_name: `MicrosoftLearning/${name}`,
  archived: false,
  disabled: false,
  private: false,
  has_pages: true,
  fork: false,
  created_at: "2026-09-22T10:00:00Z",
  pushed_at: "2026-10-08T10:00:00Z",
  description: "",
  ...extra,
});

/** The world most tests use: two exams, three linked repositories, an org with three repos. */
async function world(extraFiles = {}, serverState = {}) {
  const docs = await makeDocs({
    "azure/AZ-400.mdx": page("exam"),
    "aibusiness/AB-650.mdx": page("exam"),
    "labs/azure/az-400.mdx": page(
      "https://microsoftlearning.github.io/AZ400-OLD/Instructions/a.html",
      "https://github.com/MicrosoftLearning/mslearn-devops",
      "https://github.com/arvigeus/AZ-204",
    ),
    ...extraFiles,
  });
  const github = await fakeGithub({
    repos: {
      "MicrosoftLearning/AZ400-OLD": {
        body: repoBody("MicrosoftLearning/AZ400-OLD", { archived: true }),
        readme: README_AZ400,
      },
      "MicrosoftLearning/mslearn-devops": {
        body: repoBody("MicrosoftLearning/mslearn-devops"),
        readme: README_PLAIN,
      },
      "arvigeus/AZ-204": { body: repoBody("arvigeus/AZ-204") },
    },
    org: {
      MicrosoftLearning: [
        orgItem("AZ400-OLD", { archived: true }),
        orgItem("mslearn-devops"),
        orgItem("AB-650T00_administer_microsoft_365_and_ai_services"),
        orgItem("AB-650T00_administer_microsoft_365_and_ai_services.ja-jp"),
      ],
    },
    ...serverState,
  });
  const env = {
    GH_TOKEN: "test-token",
    DOCS_DIR: docs.docsDir,
    TRACKER_FILE: docs.trackerFile,
    IGNORE_FILE: docs.ignoreFile,
    // a file that does not exist: the tests must not depend on the real retiring exams
    RETIRING_EXAMS_FILE: join(docs.dir, "no-retiring-exams.json"),
    REPORT_FILE: docs.reportFile,
    ERROR_FILE: docs.errorFile,
    GITHUB_OUTPUT: docs.outputFile,
    GITHUB_STEP_SUMMARY: docs.summaryFile,
    GITHUB_API_URL: github.origin,
    REQUEST_DELAY_MS: "0",
    RETRY_BASE_MS: "1",
    MIN_REFERENCES: "1",
    MIN_ORG_REPOS: "1",
    TODAY: "2026-10-14",
  };
  after(() => github.close());
  return { docs, github, env };
}

const cfgOf = (env, extra) => loadConfig(env, extra);

/** The tracker as main() leaves it once the issue was written: what was reported is remembered. */
const reportedTracker = (result, today = "2026-10-14") =>
  trackerContent({
    ...result.nextTracker,
    lastSynced: today,
    reported: { lastReported: today, items: result.items },
  });

test("a first run reports the problems it finds and records the hub-code repositories as a silent baseline", async () => {
  const { github, env } = await world();
  const result = await run(cfgOf(env));

  assert.deepEqual(
    result.linkedFindings.map((f) => [f.repo, f.kind]),
    [["MicrosoftLearning/AZ400-OLD", "archived"]],
    "an existing problem is actionable, so it is reported on the first run",
  );
  const archived = result.linkedFindings[0];
  assert.deepEqual(archived.detail.successors, [
    { repo: "MicrosoftLearning/mslearn-devops", state: "ok" },
  ]);
  assert.equal(archived.firstSeen, "2026-10-14");

  assert.equal(result.firstBaseline, true);
  assert.deepEqual(result.newFindings, [], "the baseline is silent");
  assert.deepEqual(
    result.baselined.map((c) => c.fullName),
    ["MicrosoftLearning/AB-650T00_administer_microsoft_365_and_ai_services"],
  );
  assert.deepEqual(
    result.nextTracker.baseline,
    [
      "MicrosoftLearning/AB-650T00_administer_microsoft_365_and_ai_services",
      "MicrosoftLearning/AZ400-OLD",
    ],
    "the baseline holds every hub-code repository, linked or not: dropping a link later must not make a live repository look new",
  );
  assert.equal(result.nextTracker.baselineAt, "2026-10-14");
  assert.deepEqual(Object.keys(result.nextTracker.problems), [
    "microsoftlearning/az400-old|archived",
  ]);
  assert.equal(result.requests, github.log.length);
  assert.ok(github.log.every((r) => r.auth === "Bearer test-token"));
  assert.ok(
    !github.log.some((r) => r.path.includes("arvigeus/AZ-204/readme")),
    "no README request for a third party",
  );
  assert.ok(result.trackerChanged);
  assert.ok(existsSync(env.REPORT_FILE));
  assert.match(readFileSync(env.REPORT_FILE, "utf8"), /AZ400-OLD/);
});

test("once baselined, only a repository that appears afterwards is new, and linking it clears it", async () => {
  const { docs, github, env } = await world();
  const first = await run(cfgOf(env));
  writeFileSync(docs.trackerFile, reportedTracker(first));

  const second = await run(cfgOf(env));
  assert.deepEqual(
    second.newFindings,
    [],
    "the baseline repository is not new",
  );
  assert.ok(!second.trackerChanged, "an unchanged situation changes no file");

  github.org.MicrosoftLearning.unshift(
    orgItem("AB-650T00-Next-Generation"),
    orgItem("AB-650T00-Next-Generation.fr-fr"),
    orgItem("mslearn-ai-fundamentals"),
  );
  const third = await run(cfgOf(env));
  assert.deepEqual(
    third.newFindings.map((f) => [f.repo, f.kind, f.candidate.codes]),
    [["MicrosoftLearning/AB-650T00-Next-Generation", "new-repo", ["AB-650"]]],
  );
  assert.deepEqual(third.added, [
    "microsoftlearning/ab-650t00-next-generation|new-repo",
  ]);
  assert.match(third.report, /New repositories that look like labs/);
  assert.match(third.commentBody, /^### Update 2026-10-14/);
  assert.ok(third.plan.changed && third.plan.active);

  // somebody links it from the lab page: it is not new any more
  mkdirSync(join(docs.docsDir, "labs", "aibusiness"), { recursive: true });
  writeFileSync(
    join(docs.docsDir, "labs", "aibusiness", "ab-650.mdx"),
    page("https://github.com/MicrosoftLearning/AB-650T00-Next-Generation"),
  );
  github.repos["MicrosoftLearning/AB-650T00-Next-Generation"] = {
    body: repoBody("MicrosoftLearning/AB-650T00-Next-Generation"),
    readme: README_PLAIN,
  };
  const fourth = await run(cfgOf(env));
  assert.deepEqual(fourth.newFindings, []);
});

test("a repository made public later is found even though it was created long ago", async () => {
  const { docs, github, env } = await world();
  const first = await run(cfgOf(env));
  writeFileSync(docs.trackerFile, trackerContent(first.nextTracker));
  github.org.MicrosoftLearning.push(
    orgItem("AB-650-staged-privately", { created_at: "2024-01-01T00:00:00Z" }),
  );
  const next = await run(cfgOf(env));
  assert.deepEqual(
    next.newFindings.map((f) => f.repo),
    ["MicrosoftLearning/AB-650-staged-privately"],
  );
});

test("a repository for an exam a hub page announces is new too, and the report says the exam has no page yet", async () => {
  const { docs, github, env } = await world({
    "power/PL-400.mdx": page(
      "PL-400 is moving to [AB-400](https://learn.microsoft.com/credentials/certifications/exams/ab-400)",
    ),
  });
  github.org.MicrosoftLearning.push(
    orgItem("AB-400-microsoft-power-platform-developer", {
      created_at: "2026-09-30T02:36:09Z",
    }),
  );
  const first = await run(cfgOf(env));
  assert.deepEqual([...first.relatedExams.keys()], ["AB-400"]);
  assert.deepEqual(
    first.newFindings,
    [],
    "the baseline is silent for related exams too",
  );
  assert.ok(
    first.nextTracker.baseline.includes(
      "MicrosoftLearning/AB-400-microsoft-power-platform-developer",
    ),
  );

  writeFileSync(docs.trackerFile, reportedTracker(first));
  github.org.MicrosoftLearning.unshift(orgItem("AB-400-labs-part-2"));
  const next = await run(cfgOf(env));
  assert.deepEqual(
    next.newFindings.map((f) => [f.repo, f.candidate.codes]),
    [["MicrosoftLearning/AB-400-labs-part-2", ["AB-400"]]],
  );
  assert.match(
    next.report,
    /no hub page for AB-400 yet \(named in `src\/content\/docs\/power\/PL-400\.mdx:4`\)/,
  );
});

test("a lookup that fails keeps the previous finding and its first-detected date, with a warning", async () => {
  const { docs, github, env } = await world();
  const first = await run(cfgOf(env));
  writeFileSync(docs.trackerFile, reportedTracker(first));

  github.repos["MicrosoftLearning/AZ400-OLD"].failures = [502, 502, 502, 502];
  const later = await run(
    cfgOf({ ...env, TODAY: "2026-10-20", MAX_UNKNOWN_PCT: "100" }),
  );
  assert.equal(later.unknown, 1);
  assert.match(later.warnings[0], /AZ400-OLD: the lookup failed/);
  assert.deepEqual(
    later.linkedFindings.map((f) => [f.repo, f.kind, f.carried, f.firstSeen]),
    [["MicrosoftLearning/AZ400-OLD", "archived", true, "2026-10-14"]],
  );
  assert.deepEqual(
    later.added,
    [],
    "a failed lookup neither adds nor resolves anything",
  );
  assert.deepEqual(later.resolved, []);
  assert.ok(!later.trackerChanged);
});

test("when the problem is fixed the finding goes away and is reported as resolved", async () => {
  const { docs, github, env } = await world();
  const first = await run(cfgOf(env));
  writeFileSync(docs.trackerFile, trackerContent(first.nextTracker));
  writeFileSync(
    docs.trackerFile,
    trackerContent({
      ...first.nextTracker,
      reported: { lastReported: "2026-10-14", items: first.items },
    }),
  );
  // the lab page no longer links the archived repository
  writeFileSync(
    join(docs.docsDir, "labs", "azure", "az-400.mdx"),
    page("https://github.com/MicrosoftLearning/mslearn-devops"),
  );
  github.repos["arvigeus/AZ-204"].body.archived = false;
  const fixed = await run(cfgOf(env));
  assert.deepEqual(fixed.linkedFindings, []);
  assert.deepEqual(fixed.resolved, ["microsoftlearning/az400-old|archived"]);
  assert.equal(fixed.active, false);
  assert.equal(fixed.report, null);
  assert.deepEqual(fixed.nextTracker.problems, {});
});

test("the ignore list silences a kept problem, names stale entries, and a worse problem is still reported", async () => {
  const { docs, github, env } = await world();
  writeFileSync(
    docs.ignoreFile,
    JSON.stringify({
      ignored: [
        {
          repo: "MicrosoftLearning/AZ400-OLD",
          problems: ["archived"],
          reason: "AZ-400 page keeps it until the labs are rewritten",
        },
        {
          repo: "MicrosoftLearning/not-linked-any-more",
          problems: ["archived"],
          reason: "left over",
        },
      ],
    }),
  );
  const quiet = await run(cfgOf(env));
  assert.deepEqual(quiet.linkedFindings, []);
  assert.equal(quiet.ignoredCount, 1);
  assert.deepEqual(quiet.staleIgnore, [
    "MicrosoftLearning/not-linked-any-more (archived)",
  ]);
  assert.equal(quiet.active, false);

  delete github.repos["MicrosoftLearning/AZ400-OLD"];
  const worse = await run(cfgOf(env));
  assert.deepEqual(
    worse.linkedFindings.map((f) => f.kind),
    ["gone"],
  );
});

test("report_all lists the baselined, unlinked hub-code repositories once, without remembering them", async () => {
  const { docs, env } = await world();
  const first = await run(cfgOf({ ...env, REPORT_ALL: "1" }));
  assert.deepEqual(
    first.newFindings.map((f) => [f.persist, f.repo]),
    [
      [
        false,
        "MicrosoftLearning/AB-650T00_administer_microsoft_365_and_ai_services",
      ],
    ],
  );
  assert.match(first.report, /baselined, listed because of report_all/);
  assert.ok(first.plan.forced);
  assert.ok(
    !first.items.some((item) => item.includes("ab-650")),
    "the listing is not state: the next normal run is not compared with it",
  );
  writeFileSync(docs.trackerFile, trackerContent(first.nextTracker));
  const normal = await run(cfgOf(env));
  assert.deepEqual(normal.newFindings, []);
});

test("force_baseline accepts a flood of new repositories silently", async () => {
  const { docs, github, env } = await world();
  const first = await run(cfgOf(env));
  writeFileSync(docs.trackerFile, trackerContent(first.nextTracker));
  for (let i = 0; i < 4; i++)
    github.org.MicrosoftLearning.push(orgItem(`AB-650-extra-${i}`));

  await assert.rejects(
    run(cfgOf({ ...env, MAX_NEW_REPOS: "3" })),
    (error) =>
      error instanceof CheckError &&
      /4 unlinked repositories with a hub exam code appeared at once/.test(
        error.message,
      ) &&
      /FORCE_BASELINE=1/.test(error.message),
  );
  const forced = await run(
    cfgOf({ ...env, MAX_NEW_REPOS: "3", FORCE_BASELINE: "1" }),
  );
  assert.deepEqual(forced.newFindings, []);
  assert.equal(forced.nextTracker.baseline.length, 6);
  assert.match(
    readFileSync(env.REPORT_FILE, "utf8"),
    /AZ400-OLD/,
    "the linked problems are still reported",
  );
});

test("failsafes: too many problems, too many failed lookups, a wrong-looking organisation or content, no token", async () => {
  const { github, env } = await world();

  await assert.rejects(
    run(cfgOf({ ...env, MAX_PROBLEMS: "0" })),
    /1 problems on linked repositories at once \(more than 0\).*max_problems/,
  );
  const ok = await run(cfgOf({ ...env, MAX_PROBLEMS: "1" }));
  assert.equal(ok.linkedFindings.length, 1);

  // mslearn-devops is also looked up as the successor of AZ400-OLD, which uses up three answers first
  github.repos["MicrosoftLearning/mslearn-devops"].failures =
    Array(8).fill(502);
  await assert.rejects(
    run(cfgOf({ ...env, MAX_UNKNOWN_PCT: "10" })),
    /1 of 3 repository lookups failed.*no result is trusted/,
  );

  await assert.rejects(
    run(cfgOf({ ...env, MIN_ORG_REPOS: "100" })),
    /returned only 4 public repositories \(at least 100 are expected\)/,
  );
  await assert.rejects(
    run(cfgOf({ ...env, MIN_REFERENCES: "50" })),
    /Only 3 GitHub repositories were found/,
  );
  await assert.rejects(
    run(cfgOf({ ...env, GH_TOKEN: "", GITHUB_TOKEN: "" })),
    /No GitHub token/,
  );
  await assert.rejects(
    run(cfgOf({ ...env, DOCS_DIR: join(env.DOCS_DIR, "labs", "azure") })),
    /No exam page/,
    "a docs folder without the area folders has no hub exam code",
  );
});

test("a run that reaches its deadline fails the check and says so, instead of running into the job timeout", async (t) => {
  const { github, env } = await world();
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  const slow = async (url, options) => {
    const res = await fetch(url, options);
    t.mock.timers.tick(2_000);
    return res;
  };
  await assert.rejects(
    run(cfgOf({ ...env, RUN_DEADLINE_MS: "1000" }, { fetch: slow })),
    (error) =>
      error instanceof CheckError &&
      /repository lookups failed/.test(error.message) &&
      /the run deadline \(RUN_DEADLINE_MS=1000 ms\) was reached, so the GitHub API is probably slow or hanging/.test(
        error.message,
      ),
  );
  assert.ok(
    github.log.length < 6,
    "the lookups after the deadline were not requested",
  );
});

test("an end to end run reports a project page that is gone although the user site exists", async () => {
  const { docs, github, env } = await world({
    "labs/security/sc-200.mdx": page(
      "https://microsoft.github.io/PartnerResources/security-academy/sc-200",
    ),
  });
  github.repos["microsoft/microsoft.github.io"] = {
    body: repoBody("microsoft/microsoft.github.io"),
    readme: README_PLAIN,
  };
  const pages = [];
  const routed = async (url, options) => {
    if (url.startsWith(github.origin)) return fetch(url, options);
    pages.push(url);
    return new Response("not found", { status: 404 });
  };
  const first = await run(cfgOf(env, { fetch: routed }));
  const gone = first.linkedFindings.find((f) => f.kind === "gone");
  assert.equal(gone.repo, "microsoft/PartnerResources");
  assert.deepEqual(gone.detail, { code: 404, page: true });
  assert.deepEqual(pages, ["https://microsoft.github.io/PartnerResources/"]);
  assert.match(first.report, /GitHub Pages address returns HTTP 404/);

  // The finding is remembered with its detail and not reported again.
  writeFileSync(docs.trackerFile, reportedTracker(first));
  const again = await run(cfgOf(env, { fetch: routed }));
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.nextTracker.problems, first.nextTracker.problems);
  assert.ok(!again.trackerChanged);

  // The page comes back (a user-site directory): the finding is resolved.
  const back = await run(
    cfgOf(env, {
      fetch: async (url, options) =>
        url.startsWith(github.origin)
          ? fetch(url, options)
          : new Response("<html></html>", { status: 200 }),
    }),
  );
  assert.ok(!back.linkedFindings.some((f) => f.repo.includes("Partner")));
  assert.ok(
    back.resolved.some((id) => id.startsWith("microsoft/partnerresources")),
  );
});

test("archived and disabled organisation repositories with a hub exam code are not new labs", async () => {
  const { docs, github, env } = await world();
  const first = await run(cfgOf(env));
  writeFileSync(docs.trackerFile, reportedTracker(first));
  github.org.MicrosoftLearning.push(
    orgItem("AB-650T00_old_archived", { archived: true }),
    orgItem("AB-650T00_old_disabled", { disabled: true }),
  );
  const next = await run(cfgOf(env));
  assert.deepEqual(next.newFindings, []);
  github.org.MicrosoftLearning.push(orgItem("AB-650T00_fresh_lab"));
  const fresh = await run(cfgOf(env));
  assert.deepEqual(
    fresh.newFindings.map((f) => f.repo),
    ["MicrosoftLearning/AB-650T00_fresh_lab"],
  );
});

test("a corrupt tracker or ignore list stops the run", async () => {
  const { docs, env } = await world();
  writeFileSync(docs.trackerFile, "{ nope");
  await assert.rejects(run(cfgOf(env)), /Corrupt tracker/);
  rmIfExists(docs.trackerFile);
  writeFileSync(docs.ignoreFile, '{"ignored": [{"repo": "a/b"}]}');
  await assert.rejects(run(cfgOf(env)), /lab-repos-ignore\.json/);
});

function rmIfExists(file) {
  if (existsSync(file)) writeFileSync(file, JSON.stringify(emptyTracker()));
}

// ---------------------------------------------------------------------------
// End to end: the script, a fake GitHub API and a fake gh
// ---------------------------------------------------------------------------
const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const command = args.slice(0, 2).join(" ");
const stdin = arg("--body-file") === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ command, args, stdin }) + "\\n");
if (process.env.FAKE_GH_FAIL && process.env.FAKE_GH_FAIL.split(",").includes(command)) {
  console.error("fake gh: " + command + " failed on purpose");
  process.exit(1);
}
const stateFile = process.env.FAKE_GH_STATE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { next: 1, issues: [], labels: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const find = () => state.issues.find((i) => i.number === Number(args[2]));
if (command === "issue list") {
  const label = arg("--label");
  console.log(JSON.stringify(state.issues.filter((i) => i.state === "open" && i.labels.includes(label)).map(({ number, title }) => ({ number, title }))));
} else if (command === "label create") {
  state.labels.push(args[2]); save();
} else if (command === "issue create") {
  const issue = { number: state.next++, title: arg("--title"), labels: [arg("--label")], body: stdin, state: "open", comments: [] };
  state.issues.push(issue); save();
  console.log("https://github.com/mscerts/hub/issues/" + issue.number);
} else if (command === "issue comment") {
  find().comments.push(stdin); save();
} else if (command === "issue close") {
  const issue = find(); issue.state = "closed"; issue.comments.push(arg("--comment")); save();
}
`;

function withIssues(dir) {
  const file = join(dir, "fake-gh.mjs");
  const log = join(dir, "gh.log");
  const state = join(dir, "gh-state.json");
  writeFileSync(file, FAKE_GH);
  writeFileSync(log, "");
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    env: {
      CREATE_ISSUES: "1",
      GH_CLI_SCRIPT: file,
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
      FAKE_GH_FAIL: "",
    },
    calls,
    writes: () =>
      calls().filter((c) =>
        [
          "label create",
          "issue create",
          "issue comment",
          "issue close",
        ].includes(c.command),
      ),
    issues: () =>
      existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).issues : [],
    setIssues: (issues) =>
      writeFileSync(state, JSON.stringify({ next: 100, issues, labels: [] })),
  };
}

function runScript(env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const outputs = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

test("end to end: one issue is created, repeated runs stay quiet, a change is a comment, and it closes when clean", async () => {
  const { docs, github, env } = await world();
  const gh = withIssues(docs.dir);
  const base = { ...env, ...gh.env };

  // day 1: the archived repository is reported in ONE issue, the baseline stays silent
  let res = await runScript(base);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(
    gh.writes().map((c) => c.command),
    ["label create", "issue create"],
  );
  const created = gh.issues();
  assert.equal(created.length, 1);
  assert.equal(created[0].title, ISSUE_TITLE);
  assert.deepEqual(created[0].labels, ["enhancement"]);
  assert.match(created[0].body, /AZ400-OLD/);
  assert.ok(
    !created[0].body.includes("AB-650T00"),
    "the baseline is not in the issue",
  );
  let out = outputs(docs.outputFile);
  assert.equal(out.changes_found, "true");
  assert.equal(out.baseline_updated, "true");
  assert.equal(out.extraction_failed, "false");
  assert.match(out.issue_title, /^Lab repos 2026-10-14: 1 linked repository$/);
  let tracker = JSON.parse(readFileSync(docs.trackerFile, "utf8"));
  assert.equal(tracker.lastSynced, "2026-10-14");
  assert.equal(tracker.reported.lastReported, "2026-10-14");
  assert.deepEqual(tracker.reported.items, [
    "microsoftlearning/az400-old|archived",
  ]);
  assert.deepEqual(tracker.baseline, [
    "MicrosoftLearning/AB-650T00_administer_microsoft_365_and_ai_services",
    "MicrosoftLearning/AZ400-OLD",
  ]);
  assert.match(
    readFileSync(docs.summaryFile, "utf8"),
    /Hub-code repositories that exist but are not linked/,
  );
  assert.ok(
    !readFileSync(docs.summaryFile, "utf8").includes(
      "[MicrosoftLearning/AZ400-OLD](",
    ),
    "a linked repository is not listed as unlinked in the summary",
  );

  // day 2: nothing changed: no write, no commit
  writeFileSync(docs.outputFile, "");
  const writesBefore = gh.writes().length;
  res = await runScript({ ...base, TODAY: "2026-10-15" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(
    gh.writes().length,
    writesBefore,
    "an unchanged list writes nothing to GitHub",
  );
  out = outputs(docs.outputFile);
  assert.equal(out.changes_found, "false");
  assert.equal(out.baseline_updated, "false");
  assert.equal(out.issue_title, "");

  // day 3: another repository is archived: a comment on the same issue
  github.repos["arvigeus/AZ-204"].body.archived = true;
  res = await runScript({ ...base, TODAY: "2026-10-16" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(gh.issues().length, 1, "never a second issue");
  assert.equal(gh.issues()[0].comments.length, 1);
  assert.match(gh.issues()[0].comments[0], /^### Update 2026-10-16/);
  assert.match(
    gh.issues()[0].comments[0],
    /New since the last report \(1\).*arvigeus\/az-204: archived/,
  );
  assert.equal(outputs(docs.outputFile).changes_found, "true");
  tracker = JSON.parse(readFileSync(docs.trackerFile, "utf8"));
  assert.equal(tracker.reported.items.length, 2);
  assert.equal(
    tracker.problems["arvigeus/az-204|archived"].firstSeen,
    "2026-10-16",
  );
  assert.equal(
    tracker.problems["microsoftlearning/az400-old|archived"].firstSeen,
    "2026-10-14",
    "first detected survives later runs",
  );

  // day 4: everything is fixed: the issue is closed with a comment
  github.repos["arvigeus/AZ-204"].body.archived = false;
  github.repos["MicrosoftLearning/AZ400-OLD"].body.archived = false;
  github.repos["MicrosoftLearning/AZ400-OLD"].readme = README_PLAIN;
  res = await runScript({ ...base, TODAY: "2026-10-17" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const closed = gh.issues()[0];
  assert.equal(closed.state, "closed");
  assert.match(closed.comments.at(-1), /nothing left to review/);
  tracker = JSON.parse(readFileSync(docs.trackerFile, "utf8"));
  assert.deepEqual(tracker.problems, {});
  assert.deepEqual(tracker.reported.items, []);

  // day 5: the next finding opens a new issue
  github.repos["arvigeus/AZ-204"].body.archived = true;
  res = await runScript({ ...base, TODAY: "2026-10-18" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(gh.issues().length, 2);
  assert.equal(gh.issues()[1].state, "open");
});

test("end to end: an issue closed by hand while the problem remains comes back as a reminder after 7 days, not every day", async () => {
  const { docs, env } = await world();
  const gh = withIssues(docs.dir);
  const base = { ...env, ...gh.env };

  let res = await runScript(base);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(gh.issues().length, 1);
  gh.setIssues(gh.issues().map((i) => ({ ...i, state: "closed" })));

  res = await runScript({ ...base, TODAY: "2026-10-20" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(
    gh.issues().filter((i) => i.state === "open").length,
    0,
    "6 days later: still quiet",
  );

  res = await runScript({ ...base, TODAY: "2026-10-21" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(
    gh.issues().filter((i) => i.state === "open").length,
    1,
    "7 days later: reminder issue",
  );
});

test("end to end: DRY_RUN touches no issue, and the issue is written before the tracker", async () => {
  const { docs, env } = await world();
  const gh = withIssues(docs.dir);

  let res = await runScript({ ...env, ...gh.env, DRY_RUN: "1" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(gh.calls(), [], "no gh call at all");
  assert.match(res.stdout, /not touched \(DRY_RUN\)/);
  assert.equal(outputs(docs.outputFile).changes_found, "true");
  let tracker = JSON.parse(readFileSync(docs.trackerFile, "utf8"));
  assert.equal(
    tracker.reported.lastReported,
    null,
    "nothing was reported, so nothing is remembered as reported",
  );
  rmSync(docs.trackerFile);

  // the issue cannot be created: the run fails and the tracker is not written
  writeFileSync(docs.outputFile, "");
  res = await runScript({ ...env, ...gh.env, FAKE_GH_FAIL: "issue create" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /issue create failed/);
  assert.ok(!existsSync(docs.trackerFile), "no tracker without the issue");
  assert.equal(outputs(docs.outputFile).extraction_failed, "true");

  // a lookup that fails while there is nothing to report is only a warning
  rmSync(docs.trackerFile, { force: true });
  const clean = await world();
  clean.github.repos["MicrosoftLearning/AZ400-OLD"].body.archived = false;
  clean.github.repos["MicrosoftLearning/AZ400-OLD"].readme = README_PLAIN;
  const cleanGh = withIssues(clean.docs.dir);
  res = await runScript({
    ...clean.env,
    ...cleanGh.env,
    FAKE_GH_FAIL: "issue list",
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /lookup-failed/);
  tracker = JSON.parse(readFileSync(clean.docs.trackerFile, "utf8"));
  assert.deepEqual(tracker.baseline, [
    "MicrosoftLearning/AB-650T00_administer_microsoft_365_and_ai_services",
    "MicrosoftLearning/AZ400-OLD",
  ]);
});

test("end to end: a failing check raises one failure issue, comments on it, writes nothing else, and the next healthy run closes it", async () => {
  const { docs, env } = await world();
  const gh = withIssues(docs.dir);
  const broken = { ...env, ...gh.env, GH_TOKEN: "" };

  let res = await runScript(broken);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No GitHub token/);
  assert.match(readFileSync(docs.errorFile, "utf8"), /No GitHub token/);
  let out = outputs(docs.outputFile);
  assert.equal(out.extraction_failed, "true");
  assert.equal(out.changes_found, "false");
  assert.equal(out.baseline_updated, "false");
  assert.ok(!existsSync(docs.trackerFile));
  assert.equal(gh.issues().length, 1);
  assert.equal(gh.issues()[0].title, FAILED_ISSUE_TITLE);
  assert.deepEqual(gh.issues()[0].labels, ["bug"]);

  res = await runScript({ ...broken, TODAY: "2026-10-15" });
  assert.equal(res.status, 1);
  assert.equal(gh.issues().length, 1, "a comment, not a second issue");
  assert.equal(gh.issues()[0].comments.length, 1);

  res = await runScript({ ...env, ...gh.env, TODAY: "2026-10-16" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const failure = gh.issues().find((i) => i.title === FAILED_ISSUE_TITLE);
  assert.equal(failure.state, "closed");
  assert.equal(gh.issues().filter((i) => i.title === ISSUE_TITLE).length, 1);
});

test("end to end: an authentication failure from GitHub is a failed check, not a finding", async () => {
  const { docs, github, env } = await world();
  const gh = withIssues(docs.dir);
  github.repos["MicrosoftLearning/mslearn-devops"] = {
    status: 401,
    body: { message: "Bad credentials" },
  };
  const res = await runScript({ ...env, ...gh.env });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rejected the token/);
  assert.ok(!existsSync(docs.trackerFile));
  assert.ok(!gh.issues().some((i) => i.title === ISSUE_TITLE));
});

test("end to end: a lookup that failed and an ignore entry that matches nothing are workflow annotations with their own titles", async () => {
  const { docs, github, env } = await world();
  // a repository that answers 502 on every try: its lookup is unknown, the run goes on
  github.repos["arvigeus/AZ-204"].failures = [502, 502, 502, 502];
  writeFileSync(
    docs.ignoreFile,
    JSON.stringify({
      ignored: [
        {
          repo: "MicrosoftLearning/not-linked-any-more",
          problems: ["archived"],
          reason: "left over",
        },
      ],
    }),
  );
  const res = await runScript({ ...env, MAX_UNKNOWN_PCT: "100" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(
    res.stdout,
    /^::warning title=Lab repo lookup failed::.*AZ-204: the lookup failed \(.*\); the previous result is kept$/m,
  );
  assert.match(
    res.stdout,
    /^::warning title=Stale ignore entries::lab-repos-ignore\.json entries that match nothing now: MicrosoftLearning\/not-linked-any-more \(archived\)$/m,
  );
});

// ---------------------------------------------------------------------------
// The workflow, the data files and the documentation
// ---------------------------------------------------------------------------
const workflowSource = readFileSync(workflowFile, "utf8");

test("the workflow runs daily at its own minute and no other pushing monitor starts then", () => {
  const cron = (source) =>
    [...source.matchAll(/^\s*- cron: "(\d+) (\d+) (\S+) (\S+) (\S+)"/gm)].map(
      (m) => m.slice(1, 6),
    );
  const [mine, ...extra] = cron(workflowSource);
  assert.equal(extra.length, 0, "one schedule");
  assert.deepEqual(mine, ["50", "8", "*", "*", "*"]);

  const dir = join(root, ".github", "workflows");
  for (const name of readdirSync(dir)) {
    if (name === "lab-repos-check.yml" || !name.endsWith(".yml")) continue;
    const other = readFileSync(join(dir, name), "utf8");
    if (!/git push/.test(other)) continue;
    for (const schedule of cron(other)) {
      assert.notDeepEqual(
        schedule.slice(0, 2),
        mine.slice(0, 2),
        `${name} starts at the same time`,
      );
    }
  }
});

test("the workflow gives the script the token and inputs it reads and commits the tracker only after the check", () => {
  assert.match(workflowSource, /node-version-file: \.node-version/);
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(
    workflowSource,
    /^ {2}group: lab-repos-check\n {2}cancel-in-progress: false$/m,
  );
  assert.match(workflowSource, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflowSource, /CREATE_ISSUES: "1"/);
  assert.match(
    workflowSource,
    /REPORT_ALL: \$\{\{ inputs\.report_all && '1' \|\| '' \}\}/,
  );
  assert.match(
    workflowSource,
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
  assert.match(
    workflowSource,
    /MAX_PROBLEMS: \$\{\{ inputs\.max_problems \}\}/,
  );
  assert.match(
    workflowSource,
    /^ {6}REPORT_FILE: \/tmp\/lab-repos-report\.md$/m,
  );
  assert.match(workflowSource, /^ {6}ERROR_FILE: \/tmp\/lab-repos-error\.md$/m);
  for (const input of ["report_all", "force_baseline", "max_problems"]) {
    assert.match(workflowSource, new RegExp(`^ {6}${input}:\\n`, "m"), input);
  }
  assert.ok(
    workflowSource.includes(`"${ISSUE_TITLE}"`),
    "the stable title is named",
  );
  assert.ok(workflowSource.includes(`"${FAILED_ISSUE_TITLE}"`));
  assert.ok(workflowSource.includes("node scripts/lab-repos-check.mjs"));

  const checkAt = workflowSource.indexOf("id: check");
  const commitAt = workflowSource.indexOf("Commit updated lab repo tracker");
  assert.ok(checkAt > 0 && commitAt > checkAt, "check, then commit");
  const commit = workflowSource.slice(commitAt);
  assert.match(commit, /if: steps\.check\.outputs\.baseline_updated == 'true'/);
  assert.ok(
    !/always\(\)|failure\(\)/.test(commit),
    "a failed check never commits",
  );
  assert.match(commit, /git add src\/data_files\/lab-repos\.json/);
  assert.match(
    commit,
    /for attempt in 1 2 3; do\n\s+git pull --rebase && git push && exit 0/,
  );
  assert.ok(
    !/create-issue-from-file/.test(workflowSource),
    "the script owns the issue",
  );
});

test("every environment variable the script reads is documented in its header", () => {
  const source = readFileSync(script, "utf8");
  const header = source.slice(0, source.indexOf("import { spawnSync }"));
  const names = new Set(
    [
      ...source
        .slice(source.indexOf("export function loadConfig"))
        .matchAll(/env\.([A-Z_]+)|num\("([A-Z_]+)"/g),
    ]
      .map((m) => m[1] ?? m[2])
      .slice(0, 80),
  );
  assert.ok(names.size > 15);
  for (const name of names) {
    assert.ok(header.includes(name), `${name} is documented in the header`);
  }
});

test("the committed data files are valid and the ignore list starts empty", () => {
  assert.deepEqual(
    loadIgnore(join(root, "src", "data_files", "lab-repos-ignore.json")),
    [],
  );
  assert.deepEqual(
    loadTracker(join(root, "src", "data_files", "lab-repos.json")),
    emptyTracker(),
  );
  assert.ok(KINDS.includes("new-repo") && KINDS[0] === "gone");
});

test("the Lab Repo Check runbook documents the monitor", () => {
  const runbook = readFileSync(
    join(root, "docs", "monitors", "lab-repo-check.md"),
    "utf8",
  );
  assert.match(runbook, /^# Lab Repo Check$/m);
  for (const needle of [
    ".github/workflows/lab-repos-check.yml",
    "scripts/lab-repos-check.mjs",
    "src/data_files/lab-repos.json",
    "src/data_files/lab-repos-ignore.json",
    "tests/scripts/lab-repos-check.test.mjs",
    ISSUE_TITLE,
    FAILED_ISSUE_TITLE,
    "MAX_PROBLEMS",
    "FORCE_BASELINE",
    "REPORT_ALL",
    "MICROSOFT_OWNERS",
  ]) {
    assert.ok(runbook.includes(needle), `the runbook mentions ${needle}`);
  }
  for (const kind of KINDS) {
    assert.ok(runbook.includes(`\`${kind}\``), `the runbook explains ${kind}`);
  }
});

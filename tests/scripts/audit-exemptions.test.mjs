import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";
import {
  EXEMPT,
  hasGithubLabsTab,
  isExempt,
} from "../../scripts/lib/audit-exemptions.mjs";

const root = resolve(import.meta.dirname, "../..");
// LF whatever the checkout did to the files (core.autocrlf on Windows).
const lf = (text) => text.replace(/\r\n/g, "\n");
const stripComments = (text) =>
  text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<!--[\s\S]*?-->/g, "");

const missing = JSON.parse(
  readFileSync(
    join(root, "src", "data_files", "missing-resources.json"),
    "utf8",
  ),
);

function examPage(code) {
  for (const area of EXAM_AREAS) {
    const file = join(root, "src", "content", "docs", area, `${code}.mdx`);
    if (existsSync(file)) return { area, file };
  }
  return null;
}

test("every exemption names a resource type of the audit, an exam with a page and a reason", () => {
  assert.ok(Object.keys(EXEMPT).length > 0);
  for (const [key, exams] of Object.entries(EXEMPT)) {
    assert.ok(key in missing, `${key} is not a resource type of the audit`);
    for (const [code, reason] of Object.entries(exams)) {
      assert.match(code, /^[A-Z]{2,3}-\d{3}$/, `${key}: ${code}`);
      assert.ok(examPage(code), `${key}: ${code} has no exam page`);
      assert.ok(
        typeof reason === "string" && reason.length >= 30,
        `${key}: ${code} needs its reason`,
      );
    }
  }
});

test("the committed audit lists no exempt exam, so a new exemption needs the audit run again", () => {
  for (const [key, exams] of Object.entries(EXEMPT)) {
    for (const code of Object.keys(exams)) {
      assert.ok(
        !missing[key].includes(code),
        `${code} is exempt for "${key}" but still in src/data_files/missing-resources.json: run node scripts/audit-missing-resources.mjs and commit the result`,
      );
    }
  }
});

test("an exemption stays true: the exempt exam still lacks the resource", () => {
  for (const code of Object.keys(EXEMPT["GitHub Labs"])) {
    const { area } = examPage(code);
    const lab = join(
      root,
      "src",
      "content",
      "docs",
      "labs",
      area,
      `${code.toLowerCase()}.mdx`,
    );
    if (!existsSync(lab)) continue; // no lab page, so no GitHub tab
    assert.equal(
      hasGithubLabsTab(stripComments(lf(readFileSync(lab, "utf8"))), code),
      false,
      `${code} now has a Microsoft GitHub tab with labs: remove its exemption from scripts/lib/audit-exemptions.mjs`,
    );
  }
});

test("an ESI exemption stays true: the exempt exam still has no ESI card of its own", () => {
  for (const code of Object.keys(EXEMPT["Microsoft ESI"] ?? {})) {
    const { file } = examPage(code);
    const titles = [
      ...stripComments(lf(readFileSync(file, "utf8"))).matchAll(
        /<LinkCard\s+title="([^"]*)"/g,
      ),
    ].map((match) => match[1].replace(/[​-‏﻿]/g, ""));
    assert.ok(
      !titles.some((title) =>
        /^Microsoft Enterprise Skills Initiative\b/i.test(title),
      ),
      `${code} now has an ESI card: remove its exemption from scripts/lib/audit-exemptions.mjs`,
    );
  }
});

test("the GitHub Labs tab counts only when it is active and holds a card", () => {
  const tab = (inner) =>
    `<Tabs><TabItem label="Microsoft GitHub">${inner}</TabItem></Tabs>`;
  assert.equal(
    hasGithubLabsTab(
      tab('<CardGrid><LinkCard title="Lab" href="x" /></CardGrid>'),
    ),
    true,
  );
  assert.equal(hasGithubLabsTab(tab("<CardGrid></CardGrid>")), false);
  assert.equal(hasGithubLabsTab(tab("")), false);
  assert.equal(hasGithubLabsTab("<Tabs></Tabs>"), false);
  assert.equal(hasGithubLabsTab(""), false);
  // a commented-out tab is gone once the comments are stripped, as the audit does
  assert.equal(
    hasGithubLabsTab(
      stripComments(`{/* ${tab('<LinkCard title="Lab" href="x" />')} */}`),
    ),
    false,
  );
});

test("a GitHub lab kept from the predecessor exam (titled with its code) is not the exam's own lab", () => {
  const tab = (inner) =>
    `<Tabs><TabItem label="Microsoft GitHub"><CardGrid>${inner}</CardGrid></TabItem></Tabs>`;
  const kept = '<LinkCard title="MB-330: Case Study 1" href="x" />';
  const own = '<LinkCard title="Case Study 1" href="x" />';
  assert.equal(hasGithubLabsTab(tab(kept), "AB-330"), false);
  assert.equal(hasGithubLabsTab(tab(kept + own), "AB-330"), true);
  assert.equal(hasGithubLabsTab(tab(kept), "MB-330"), true);
  assert.equal(
    hasGithubLabsTab(
      tab('<LinkCard title="AB-330: Case Study 1" href="x" />'),
      "AB-330",
    ),
    true,
  );
  assert.equal(
    hasGithubLabsTab(tab(kept)),
    true,
    "without a code every card counts",
  );
});

test("isExempt answers for the resource type and the code, and only for those", () => {
  assert.equal(isExempt("GitHub Labs", "DP-750"), true);
  assert.equal(isExempt("GitHub Labs", "AZ-700"), true);
  assert.equal(isExempt("GitHub Labs", "SC-900"), false);
  assert.equal(isExempt("Udemy", "DP-750"), false);
  assert.equal(isExempt("No Such Type", "DP-750"), false);
  assert.equal(isExempt("GitHub Labs", "toString"), false);
});

test("AGENTS.md says where the exemptions are", () => {
  const agents = lf(readFileSync(join(root, "AGENTS.md"), "utf8"));
  assert.ok(agents.includes("scripts/lib/audit-exemptions.mjs"));
});

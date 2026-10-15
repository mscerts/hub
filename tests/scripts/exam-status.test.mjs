import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  NEW_BADGE_DAYS,
  examStatusNames,
  examStatusStyles,
  examStatuses,
  isExamStatusVisible,
  visibleExamStatuses,
} from "../../src/data_files/exam-status.mjs";

const root = join(import.meta.dirname, "..", "..");
const NEW = (since, extra = {}) => ({
  text: "NEW",
  variant: "success",
  since,
  ...extra,
});

test("a NEW badge is shown for 90 days: the since day is day 0, the 90th day hides it", () => {
  assert.equal(NEW_BADGE_DAYS, 90);
  const status = NEW("2026-09-30");
  assert.equal(isExamStatusVisible(status, "2026-09-30"), true, "day 0");
  assert.equal(isExamStatusVisible(status, "2026-12-28"), true, "day 89");
  assert.equal(isExamStatusVisible(status, "2026-12-29"), false, "day 90");
  assert.equal(isExamStatusVisible(status, "2027-06-01"), false, "much later");
  // a Date works like its UTC day, whatever the time of day
  assert.equal(
    isExamStatusVisible(status, new Date("2026-12-28T23:59:59Z")),
    true,
  );
  assert.equal(
    isExamStatusVisible(status, new Date("2026-12-29T00:00:00Z")),
    false,
  );
});

test("a NEW badge without a real since day, or dated in the future, is never shown", () => {
  for (const since of [
    undefined,
    null,
    "",
    "2026-9-24",
    "2026-02-31",
    "24 September 2026",
    "2026-09-24T00:00:00Z",
    20260924,
  ]) {
    assert.equal(
      isExamStatusVisible(NEW(since), "2026-10-15"),
      false,
      String(since),
    );
  }
  assert.equal(isExamStatusVisible(NEW("2026-10-16"), "2026-10-15"), false);
  assert.equal(isExamStatusVisible(NEW("2026-10-15"), "2026-10-15"), true);
});

test("every other status is always shown, and a bad today is an error, not 'never'", () => {
  for (const text of ["BETA", "RETIRING", "RETIRED", "AT RISK", "UPCOMING"]) {
    assert.equal(
      isExamStatusVisible({ text, variant: "tip" }, "2030-01-01"),
      true,
      text,
    );
  }
  assert.throws(
    () => isExamStatusVisible(NEW("2026-09-24"), "next week"),
    /Not a date/,
  );
});

test("visibleExamStatuses keeps the shape, drops expired NEW entries and the since field", () => {
  const shown = visibleExamStatuses("2026-10-15");
  assert.deepEqual(Object.keys(shown), Object.keys(examStatuses));
  assert.deepEqual(shown.azure["AI-500"], { text: "NEW", variant: "success" });
  assert.ok(
    !Object.values(shown).some((exams) =>
      Object.values(exams).some((status) => "since" in status),
    ),
    "since never reaches the badge",
  );
  assert.deepEqual(shown.microsoft365["MS-102"], {
    text: "RETIRING",
    variant: "danger",
  });
  // three and a half months on, every seeded NEW is gone and the rest stays
  const later = visibleExamStatuses("2027-02-01");
  for (const [area, exams] of Object.entries(examStatuses)) {
    for (const [code, status] of Object.entries(exams)) {
      assert.equal(
        code in later[area],
        status.text !== "NEW",
        `${code} on 2027-02-01`,
      );
    }
  }
});

test("the NEW entries of the data file are valid: a real past since day, success variant, an existing exam page", () => {
  const today = new Date().toISOString().slice(0, 10);
  const news = Object.entries(examStatuses).flatMap(([area, exams]) =>
    Object.entries(exams)
      .filter(([, status]) => status.text === "NEW")
      .map(([code, status]) => ({ area, code, status })),
  );
  assert.ok(news.length > 0, "the data file has no NEW entry to check");
  for (const { area, code, status } of news) {
    assert.equal(status.variant, "success", `${code}: variant`);
    assert.ok(
      /^\d{4}-\d{2}-\d{2}$/.test(status.since) &&
        new Date(`${status.since}T00:00:00Z`).toISOString().slice(0, 10) ===
          status.since,
      `${code}: since "${status.since}" is not a real YYYY-MM-DD day (the badge would never show)`,
    );
    assert.ok(
      status.since <= today,
      `${code}: since ${status.since} is in the future (the badge would not show yet)`,
    );
    const page = join(root, "src", "content", "docs", area, `${code}.mdx`);
    assert.ok(existsSync(page), `${code}: ${page} does not exist`);
  }
  // since belongs to NEW alone: another status that carries it is a copy-paste mistake
  for (const [area, exams] of Object.entries(examStatuses)) {
    for (const [code, status] of Object.entries(exams)) {
      if (status.text !== "NEW") {
        assert.ok(!("since" in status), `${area}/${code}: only NEW has since`);
      }
    }
  }
});

test("every status text has a name, a style and a case on the landing page, and the pages read the statuses through visibleExamStatuses", () => {
  const texts = new Set(
    Object.values(examStatuses).flatMap((exams) =>
      Object.values(exams).map((status) => status.text),
    ),
  );
  const landing = readFileSync(
    join(
      root,
      "src",
      "components",
      "sections",
      "landing",
      "QuickLinksCenter.astro",
    ),
    "utf8",
  );
  for (const text of texts) {
    const key = text.replace(" ", "_");
    assert.ok(key in examStatusNames, `${text} has no examStatusNames entry`);
    assert.ok(key in examStatusStyles, `${text} has no examStatusStyles entry`);
    assert.ok(
      landing.includes(`case "${text}":`),
      `${text} has no case in getStatusClass of QuickLinksCenter.astro (it would show in the neutral grey)`,
    );
  }
  // an expired NEW badge only goes away if both places use the filtered list
  assert.match(landing, /visibleExamStatuses\(\)/);
  assert.doesNotMatch(landing, /Object\.entries\(examStatuses\)/);
  const sidebar = readFileSync(
    join(root, "src", "data_files", "docs-sidebar.ts"),
    "utf8",
  );
  assert.match(sidebar, /visibleExamStatuses\(\)/);
  assert.doesNotMatch(sidebar, /statuses = examStatuses\[/);
});

test("the Beta Exam Monitor's GA issue tells the maintainer to set NEW with a since day", () => {
  const script = readFileSync(
    join(root, "scripts", "beta-exam-check.mjs"),
    "utf8",
  );
  assert.match(script, /text: "NEW", variant: "success", since: /);
  assert.match(script, /hides by itself after 90 days/);
});

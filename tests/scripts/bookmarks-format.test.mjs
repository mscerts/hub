import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanBookmarkTitle,
  normalizeBookmarkPath,
} from "../../src/utils/bookmarks-format.mjs";

test("normalizeBookmarkPath strips query/hash and enforces trailing slash", () => {
  assert.equal(normalizeBookmarkPath(""), "/");
  assert.equal(normalizeBookmarkPath("/"), "/");
  assert.equal(
    normalizeBookmarkPath("/certs/azure/az-104?tab=text#section"),
    "/certs/azure/az-104/",
  );
  assert.equal(
    normalizeBookmarkPath("/certs/courses/ab-731/"),
    "/certs/courses/ab-731/",
  );
});

test("cleanBookmarkTitle strips site suffixes and preserves fallback", () => {
  assert.equal(
    cleanBookmarkTitle("AZ-104 Study Materials | Microsoft Certification Hub"),
    "AZ-104 Study Materials",
  );
  assert.equal(cleanBookmarkTitle("News | MSFTHub"), "News");
  assert.equal(cleanBookmarkTitle("   "), "Microsoft Certification Hub");
});

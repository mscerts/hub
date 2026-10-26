import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFragment } from "parse5";
import { renderFileTree } from "../../src/utils/render-file-tree.mjs";
import { compareVoucherRecency } from "../../src/utils/voucher-recency.ts";

test("file tree preserves formatted labels and renders nested native folder controls", () => {
  const html = renderFileTree(
    "<ul><li>src<ul><li><p>docs &amp; guides</p><ul><li><strong>page.mdx</strong></li></ul></li></ul></li></ul>",
  );
  const root = parseFragment(html);
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    node.childNodes?.forEach(visit);
  };
  visit(root);
  assert.equal(nodes.filter((n) => n.tagName === "details").length, 2);
  assert.equal(nodes.filter((n) => n.tagName === "summary").length, 2);
  assert.ok(
    nodes
      .filter((n) => n.tagName === "details")
      .every((n) => n.attrs.some((a) => a.name === "open")),
  );
  assert.match(html, /<strong>page.mdx<\/strong>/);
  assert.match(html, /docs &amp; guides/);
  assert.equal(nodes.filter((n) => n.tagName === "svg").length, 3);
});

test("voucher recency sorts dates descending, breaks ties by title and puts undated pages last", () => {
  const voucher = (title, lastUpdated) => ({ data: { title, lastUpdated } });
  const entries = [
    voucher("Undated", true),
    voucher("Z", new Date("2026-10-01")),
    voucher("Newest", new Date("2026-10-24")),
    voucher("A", new Date("2026-10-01")),
    voucher("Missing"),
  ];
  assert.deepEqual(
    entries.sort(compareVoucherRecency).map((v) => v.data.title),
    ["Newest", "A", "Z", "Missing", "Undated"],
  );
});

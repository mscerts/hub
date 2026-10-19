import test from "node:test";
import assert from "node:assert/strict";
import { parseFragment } from "parse5";
import { renderTabPanels } from "../../src/utils/render-tabs.mjs";

const panelsOf = (html) =>
  parseFragment(html).childNodes.filter((node) =>
    node.attrs?.some((attr) => attr.name === "data-docs-tabs-content"),
  );
const attr = (node, name) =>
  node.attrs.find((item) => item.name === name)?.value;

test("server tabs label and hide panels before scripts run, preserving escaped text and rich HTML", () => {
  const { html, tabs } = renderTabPanels(
    '<div data-docs-tabs-content data-docs-tab-label="Text &amp; docs"><p>A <strong>resource</strong></p></div><div data-docs-tabs-content data-docs-tab-label="Videos"><a href="https://example.org/">Watch</a></div>',
    "group-1",
  );
  const panels = panelsOf(html);
  assert.deepEqual(tabs, [
    { label: "Text & docs", id: "group-1-panel-0" },
    { label: "Videos", id: "group-1-panel-1" },
  ]);
  assert.equal(attr(panels[0], "hidden"), undefined);
  assert.equal(attr(panels[1], "hidden"), "");
  assert.equal(attr(panels[0], "aria-labelledby"), "group-1-panel-0-tab");
  assert.match(html, /<strong>resource<\/strong>/);
  assert.match(html, /data-docs-tab-fallback="">Text &amp; docs<\/h3>/);
});

test("outer tab preparation does not relabel or re-ID nested groups", () => {
  const inner = renderTabPanels(
    '<div data-docs-tabs-content data-docs-tab-label="Inner">Inner body</div>',
    "inner",
  );
  const outer = renderTabPanels(
    `<div data-docs-tabs-content data-docs-tab-label="Outer"><div data-docs-tabs><div data-docs-tabs-content-wrapper>${inner.html}</div></div></div>`,
    "outer",
  );
  assert.equal(outer.tabs.length, 1);
  assert.match(outer.html, /id="inner-panel-0"/);
  assert.match(outer.html, /id="outer-panel-0"/);
});

test("non-panel content is preserved and labels cannot inject HTML", () => {
  const result = renderTabPanels(
    '<!-- note --><p>Before</p><div data-docs-tabs-content data-docs-tab-label="&lt;script&gt;alert(1)&lt;/script&gt;">Body</div>',
    "safe",
  );
  assert.match(result.html, /<p>Before<\/p>/);
  const elements = (node) => [
    node,
    ...(node.childNodes ?? []).flatMap(elements),
  ];
  assert.equal(
    elements(parseFragment(result.html)).some(
      (node) => node.tagName === "script",
    ),
    false,
  );
  assert.equal(result.tabs[0].label, "<script>alert(1)</script>");
  assert.deepEqual(renderTabPanels("", "empty"), { html: "", tabs: [] });
});

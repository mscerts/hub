import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";

const root = resolve(import.meta.dirname, "../..");
const source = (file) =>
  readFileSync(join(root, file), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");

test("active exam MeasureUp sections use the shared card with explicit affiliate product links", () => {
  let migrated = 0;
  for (const area of EXAM_AREAS) {
    const dir = `src/content/docs/${area}`;
    for (const file of readdirSync(join(root, dir))) {
      if (!file.endsWith(".mdx")) continue;
      const text = source(`${dir}/${file}`);
      assert.doesNotMatch(text, /<Card title="MeasureUp Practice Tests"/, file);
      const card = text.match(
        /<MeasureUpCard>([\s\S]*?)<\/MeasureUpCard>/,
      )?.[1];
      if (!card) continue;
      migrated++;
      assert.match(
        text,
        /import MeasureUpCard from '@components\/MeasureUpCard\.astro'/,
        file,
      );
      assert.match(card, /<CardGrid slot="products">/, file);
      const links = [...card.matchAll(/<LinkCard\b[^>]*href="([^"]+)"/g)];
      assert.ok(links.length > 0, file);
      for (const [, href] of links) {
        const url = new URL(href);
        assert.equal(url.hostname, "www.measureup.com", file);
        assert.equal(url.hash, "#u44", file);
      }
      assert.doesNotMatch(
        card,
        /MeasureUp Subscriptions|exclusive 15% discount/,
        file,
      );
    }
  }
  assert.ok(migrated > 0);
});

test("predecessor disclaimers and multi-product labels remain explicit", () => {
  for (const [path, predecessor] of [
    ["azure/AZ-401", "AZ-400"],
    ["aibusiness/AB-330", "MB-330"],
    ["aibusiness/AB-400", "PL-400"],
  ]) {
    const text = source(`src/content/docs/${path}.mdx`);
    assert.ok(text.includes(`for the previous exam, ${predecessor}.`));
    assert.ok(text.includes(`title="${predecessor}: MeasureUp`));
  }
  const hybrid = source("src/content/docs/azure/AZ-802.mdx");
  const card = hybrid.match(/<MeasureUpCard>([\s\S]*?)<\/MeasureUpCard>/)[1];
  assert.equal([...card.matchAll(/<LinkCard\b/g)].length, 4);
  assert.match(card, /slot="before-discount"/);
  assert.match(card, /legacy AZ-800 and AZ-801 exams/);
});

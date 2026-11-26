import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";
import {
  bundlesForExam,
  examCodeOfEntryId,
  examCodeOfPath,
  readBundles,
} from "../../src/utils/measureup-bundles.mjs";
import { serializeMdx } from "../../src/utils/markdown/serializeMdx.ts";

const root = resolve(import.meta.dirname, "../..");

const BUNDLES = [
  {
    id: "2",
    name: "Bundle Azure Administrator (AZ-900 + AZ-104)",
    url: "https://www.measureup.com/bundle-azure-administrator.html",
    examCodes: ["AZ-104", "AZ-900"],
  },
  {
    id: "1",
    name: "Bundle (SC-100,SC-200,SC-300,SC-900): Microsoft Security Path",
    url: "https://www.measureup.com/bundle-sc-200-sc-300-sc-400-sc-900-microsoft-security-path.html",
    examCodes: ["SC-100", "SC-200", "SC-300", "SC-900"],
  },
  {
    id: "3",
    name: "Bundle Power Platform Developer (PL-900 + PL-400)",
    url: "https://www.measureup.com/bundle-pl-900-pl-400.html#u44",
    examCodes: ["PL-400", "PL-900"],
  },
  {
    id: "4",
    name: "Bundle without an address (AZ-104 + AZ-305)",
    url: "",
    examCodes: ["AZ-104", "AZ-305"],
  },
];

test("the exam code of a page comes from its address or its collection id", () => {
  assert.equal(examCodeOfPath("/certs/azure/az-104/"), "AZ-104");
  assert.equal(examCodeOfPath("/certs/microsoft365/ms-102"), "MS-102");
  for (const not of [
    "/certs/labs/azure/az-104/",
    "/certs/courses/az-104/",
    "/certs/changelog/az-104/",
    "/certs/guide/overview/",
    "/certs/",
    "",
    undefined,
  ])
    assert.equal(examCodeOfPath(not), undefined, String(not));
  assert.equal(examCodeOfEntryId("azure/az-104"), "AZ-104");
  assert.equal(examCodeOfEntryId("labs/azure/az-104"), undefined);
  assert.equal(examCodeOfEntryId("vouchers/levelup"), undefined);
  assert.equal(examCodeOfEntryId(undefined), undefined);
});

test("bundlesForExam: the bundles that include the exam, by name, with the tracking fragment and a readable title", () => {
  const cards = bundlesForExam("AZ-104", BUNDLES);
  assert.deepEqual(
    cards.map((card) => card.title),
    ["MeasureUp Bundle: Azure Administrator (AZ-900 + AZ-104)"],
    "a bundle without an address is not shown",
  );
  assert.equal(
    cards[0].href,
    "https://www.measureup.com/bundle-azure-administrator.html#u44",
  );
  assert.equal(
    cards[0].description,
    "Practice tests for AZ-104, AZ-900 in one purchase.",
  );
  // the Security Path bundle is named in a form of its own
  assert.deepEqual(
    bundlesForExam("SC-300", BUNDLES).map((c) => c.title),
    [
      "MeasureUp Bundle: Microsoft Security Path (SC-100 + SC-200 + SC-300 + SC-900)",
    ],
  );
  assert.deepEqual(bundlesForExam("gh-300", BUNDLES), []);
  assert.deepEqual(bundlesForExam(undefined, BUNDLES), []);
  assert.deepEqual(bundlesForExam("AZ-104", []), []);
  // a link that carries the fragment already keeps one
  assert.equal(
    bundlesForExam("PL-900", BUNDLES)[0].href,
    "https://www.measureup.com/bundle-pl-900-pl-400.html#u44",
  );
});

test("a bundle MeasureUp sells under PL-400 shows on AB-400, the exam PL-400 became on the hub", () => {
  assert.equal(bundlesForExam("AB-400", BUNDLES).length, 1);
  assert.equal(bundlesForExam("PL-400", BUNDLES).length, 1);
  assert.equal(bundlesForExam("PL-900", BUNDLES).length, 1);
});

test("the baseline's bundles are well formed: MeasureUp addresses with the exam codes of their pages", () => {
  const bundles = readBundles(root);
  assert.ok(bundles.length >= 10, "the baseline holds the bundles");
  const ids = new Set();
  const urls = new Set();
  for (const bundle of bundles) {
    assert.match(bundle.id, /^\d+$/, bundle.name);
    assert.ok(!ids.has(bundle.id), `duplicate id ${bundle.id}`);
    ids.add(bundle.id);
    assert.match(bundle.name, /^Bundle\b/, bundle.name);
    const url = new URL(bundle.url);
    assert.equal(url.protocol, "https:", bundle.name);
    assert.equal(url.hostname, "www.measureup.com", bundle.name);
    assert.ok(!urls.has(bundle.url), `duplicate address ${bundle.url}`);
    urls.add(bundle.url);
    assert.ok(bundle.examCodes.length >= 2, bundle.name);
    assert.deepEqual(
      bundle.examCodes,
      [...new Set(bundle.examCodes)].sort(),
      `${bundle.name}: codes sorted and unique`,
    );
    for (const code of bundle.examCodes)
      assert.match(code, /^[A-Z]{2,3}-\d{3}$/, bundle.name);
  }
});

test("every bundle of the baseline shows on the exam pages that have a MeasureUp card, and only there", () => {
  const withCard = new Set();
  for (const area of EXAM_AREAS) {
    const dir = join(root, "src", "content", "docs", area);
    for (const file of readdirSync(dir)) {
      const code = /^([A-Z]{2,3}-\d{3})\.mdx$/.exec(file)?.[1];
      if (
        code &&
        /<MeasureUpCard\b/.test(readFileSync(join(dir, file), "utf8"))
      )
        withCard.add(code);
    }
  }
  const missing = new Set();
  for (const bundle of readBundles(root))
    for (const code of bundle.examCodes) {
      const hubCode = code === "PL-400" ? "AB-400" : code;
      if (!withCard.has(hubCode)) missing.add(hubCode);
    }
  // an exam with no hub page or no MeasureUp card shows no bundles: listed, not an error, so a new
  // bundle for such an exam is noticed here when the list below is out of date
  assert.deepEqual([...missing].sort(), []);
});

test("the Markdown copy of an exam page lists its bundles under the MeasureUp products", async () => {
  const body = `<MeasureUpCard>
<CardGrid slot="products">
  <LinkCard title="MeasureUp Practice Test" href="https://www.measureup.com/x.html#u44" target="_blank"/>
</CardGrid>
</MeasureUpCard>
`;
  const copy = await serializeMdx(body, {
    examCode: "AZ-104",
    bundles: BUNDLES,
  });
  assert.match(copy, /Bundles that include this exam:/);
  assert.match(
    copy,
    /### \[MeasureUp Bundle: Azure Administrator \(AZ-900 \+ AZ-104\)\]\(https:\/\/www\.measureup\.com\/bundle-azure-administrator\.html#u44\)/,
  );
  assert.ok(
    copy.indexOf("MeasureUp Practice Test") <
      copy.indexOf("Bundles that include this exam"),
  );
  assert.ok(
    copy.indexOf("Bundles that include this exam") <
      copy.indexOf("MeasureUp Subscriptions"),
  );
  // an exam in no bundle, or a page that is no exam page: the copy is as it was
  for (const options of [
    { examCode: "GH-300", bundles: BUNDLES },
    { bundles: BUNDLES },
    { examCode: "AZ-104", bundles: [] },
  ])
    assert.doesNotMatch(
      await serializeMdx(body, options),
      /Bundles that include this exam/,
    );
});

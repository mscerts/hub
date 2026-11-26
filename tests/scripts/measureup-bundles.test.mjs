import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";
import {
  bundlesForExam,
  examCodeOfEntryId,
  examCodeOfPath,
  productsForExam,
  readBundles,
  readProducts,
  readRetiredExamCodes,
} from "../../src/utils/measureup-bundles.mjs";
import { serializeMdx } from "../../src/utils/markdown/serializeMdx.ts";

const root = resolve(import.meta.dirname, "../..");

const none = new Set();

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
  const cards = bundlesForExam("AZ-104", BUNDLES, none);
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
    bundlesForExam("SC-300", BUNDLES, none).map((c) => c.title),
    [
      "MeasureUp Bundle: Microsoft Security Path (SC-100 + SC-200 + SC-300 + SC-900)",
    ],
  );
  assert.deepEqual(bundlesForExam("gh-300", BUNDLES, none), []);
  assert.deepEqual(bundlesForExam(undefined, BUNDLES, none), []);
  assert.deepEqual(bundlesForExam("AZ-104", [], none), []);
  // a link that carries the fragment already keeps one
  assert.equal(
    bundlesForExam("PL-900", BUNDLES, none)[0].href,
    "https://www.measureup.com/bundle-pl-900-pl-400.html#u44",
  );
});

test("a bundle with a retired exam shows on none of the pages of its exams", () => {
  const retired = new Set(["PL-400"]);
  assert.deepEqual(bundlesForExam("PL-900", BUNDLES, retired), []);
  assert.deepEqual(bundlesForExam("PL-400", BUNDLES, retired), []);
  assert.equal(bundlesForExam("PL-900", BUNDLES, none).length, 1);
  // the other bundles are not affected
  assert.equal(bundlesForExam("AZ-104", BUNDLES, retired).length, 1);
  assert.equal(
    bundlesForExam("SC-100", BUNDLES, new Set(["SC-900"])).length,
    0,
  );
  assert.equal(
    bundlesForExam("SC-100", BUNDLES, new Set(["AZ-900"])).length,
    1,
  );
});

test("readRetiredExamCodes: what Learn lists as retired, or schedules for a day before today, and the tracker's passed days", () => {
  const retired = readRetiredExamCodes(root, new Date("2026-11-26T12:00:00Z"));
  assert.ok(retired.has("PL-400"), "PL-400 retired on 2026-10-30");
  assert.ok(retired.has("AZ-800") && retired.has("AZ-801"));
  assert.ok(!retired.has("MS-102"), "retires on 2026-11-30: still on offer");
  assert.ok(!retired.has("AZ-400"));
  assert.ok(!retired.has("AZ-104"));
  // the retirement day itself is still on offer; from the next day the exam counts as retired
  const onTheDay = readRetiredExamCodes(root, new Date("2026-11-30T23:59:00Z"));
  assert.ok(!onTheDay.has("MS-102"));
  const after = readRetiredExamCodes(root, new Date("2026-12-01T00:00:00Z"));
  assert.ok(after.has("MS-102"));
  assert.ok(!after.has("AZ-400"));
  assert.ok(
    readRetiredExamCodes(root, new Date("2027-02-02T00:00:00Z")).has("AZ-400"),
  );
  assert.deepEqual([...readRetiredExamCodes("/nonexistent")], []);
});

test("no bundle of the baseline that is shown holds a retired exam", () => {
  const retired = readRetiredExamCodes(root);
  const bundles = readBundles(root);
  for (const bundle of bundles)
    for (const code of bundle.examCodes) {
      const shown = bundlesForExam(code, bundles).some(
        (card) => card.href.split("#")[0] === bundle.url,
      );
      const holdsRetired = bundle.examCodes.some((c) => retired.has(c));
      assert.equal(shown, !holdsRetired, `${bundle.name} on ${code}`);
    }
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

test("every bundle of the baseline that is shown has a MeasureUp card on the page of each of its exams", () => {
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
  const retired = readRetiredExamCodes(root);
  const missing = new Set();
  for (const bundle of readBundles(root)) {
    if (bundle.examCodes.some((code) => retired.has(code))) continue;
    for (const code of bundle.examCodes)
      if (!withCard.has(code)) missing.add(code);
  }
  // an exam with no hub page or no MeasureUp card shows no bundles: listed, not an error, so a new
  // bundle for such an exam is noticed here when the list below is out of date
  assert.deepEqual([...missing].sort(), []);
});

test("the Markdown copy of an exam page lists its bundles below the MSFTHUB discount note", async () => {
  const body = `<MeasureUpCard>
<CardGrid slot="products">
  <LinkCard title="MeasureUp Practice Test" href="https://www.measureup.com/x.html#u44" target="_blank"/>
</CardGrid>
</MeasureUpCard>
`;
  const copy = await serializeMdx(body, {
    examCode: "AZ-104",
    bundles: BUNDLES,
    retired: none,
  });
  assert.match(copy, /Discounted bundles with other exams:/);
  assert.match(
    copy,
    /### \[MeasureUp Bundle: Azure Administrator \(AZ-900 \+ AZ-104\)\]\(https:\/\/www\.measureup\.com\/bundle-azure-administrator\.html#u44\)/,
  );
  assert.ok(
    copy.indexOf("MeasureUp Practice Test") <
      copy.indexOf("Discounted bundles with other exams"),
  );
  assert.ok(
    copy.indexOf("MeasureUp Subscriptions") <
      copy.indexOf("Discounted bundles with other exams"),
  );
  assert.ok(
    copy.indexOf("exclusive 15% discount") <
      copy.indexOf("Discounted bundles with other exams"),
  );
  // an exam in no bundle, or a page that is no exam page: the copy is as it was
  for (const options of [
    { examCode: "GH-300", bundles: BUNDLES, retired: none },
    { bundles: BUNDLES, retired: none },
    { examCode: "AZ-104", bundles: [], retired: none },
    { examCode: "AZ-104", bundles: BUNDLES, retired: new Set(["AZ-900"]) },
  ])
    assert.doesNotMatch(
      await serializeMdx(body, options),
      /Discounted bundles with other exams/,
    );
});

// ---------------------------------------------------------------------------
// The product cards of the MeasureUp block (a bare <MeasureUpCard />)
// ---------------------------------------------------------------------------
const PRODUCTS = [
  {
    id: "1",
    name: "Assessment AZ-900: Microsoft Azure Fundamentals",
    examCode: "AZ-900",
    type: "assessment",
    url: "https://www.measureup.com/assessment-az-900-microsoft-azure-fundamentals.html",
  },
  {
    id: "2",
    name: "評価 AZ-900: Microsoft Azure の基礎",
    examCode: "AZ-900",
    type: "assessment",
    url: "https://www.measureup.com/az-900-microsoft-azure.html",
  },
  {
    id: "3",
    name: "Microsoft Practice Test AZ-900: Microsoft Azure Fundamentals",
    examCode: "AZ-900",
    type: "practice-test",
    url: "https://www.measureup.com/microsoft-practice-test-az-900.html#u44",
  },
  {
    id: "4",
    name: "CertKit AZ-900: Microsoft Azure Fundamentals",
    examCode: "AZ-900",
    type: "certkit",
    url: "https://www.measureup.com/certkit-az-900.html",
  },
  {
    id: "5",
    name: "Assessment AZ-104: Azure Administrator",
    examCode: "AZ-104",
    type: "assessment",
    url: "https://www.measureup.com/assessment-az-104.html",
  },
];

test("productsForExam gives the English assessment and practice test, each with #u44, and no certkit", () => {
  assert.deepEqual(productsForExam("az-900", PRODUCTS), [
    {
      title: "MeasureUp Assessment",
      href: "https://www.measureup.com/assessment-az-900-microsoft-azure-fundamentals.html#u44",
    },
    {
      title: "MeasureUp Practice Test",
      href: "https://www.measureup.com/microsoft-practice-test-az-900.html#u44",
    },
  ]);
  // only the products MeasureUp has: no card is made up for the missing practice test
  assert.deepEqual(
    productsForExam("AZ-104", PRODUCTS).map((card) => card.title),
    ["MeasureUp Assessment"],
  );
  assert.deepEqual(productsForExam("GH-700", PRODUCTS), []);
  assert.deepEqual(productsForExam(undefined, PRODUCTS), []);
  assert.deepEqual(productsForExam("AZ-900", []), []);
});

test("every exam page with a bare MeasureUp card has products in the baseline, each with #u44 and a MeasureUp address", () => {
  const products = readProducts(root);
  assert.ok(products.length > 0);
  let bare = 0;
  for (const area of EXAM_AREAS) {
    const dir = join(root, "src", "content", "docs", area);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8").replace(
        /\{\/\*[\s\S]*?\*\/\}/g,
        "",
      );
      if (!/<MeasureUpCard\s*\/>/.test(text)) continue;
      bare++;
      const code = file.replace(/\.mdx$/, "");
      const cards = productsForExam(code, products);
      assert.ok(cards.length > 0, `${code}: the baseline has no product`);
      for (const card of cards) {
        assert.match(
          card.href,
          /^https:\/\/www\.measureup\.com\/.+#u44$/,
          `${code}: ${card.href}`,
        );
      }
    }
  }
  assert.ok(bare > 0, "no exam page uses the generated MeasureUp card");
});

test("the Markdown copy of a bare MeasureUp card lists the products of the baseline", async () => {
  const copy = await serializeMdx("<MeasureUpCard />\n", {
    examCode: "AZ-900",
    products: PRODUCTS,
    bundles: [],
    retired: none,
  });
  assert.match(
    copy,
    /### \[MeasureUp Assessment\]\(https:\/\/www\.measureup\.com\/assessment-az-900-microsoft-azure-fundamentals\.html#u44\)/,
  );
  assert.match(
    copy,
    /### \[MeasureUp Practice Test\]\(https:\/\/www\.measureup\.com\/microsoft-practice-test-az-900\.html#u44\)/,
  );
  assert.match(copy, /MeasureUp Subscriptions/);
  assert.doesNotMatch(copy, /certkit/i);
});

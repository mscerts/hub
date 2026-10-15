/**
 * The beta voucher page: `src/content/docs/vouchers/<code>beta.mdx`, the page of
 * the 80% discount that Microsoft announces for a beta exam (AGENTS.md, "Beta
 * voucher format"). `buildBetaVoucherPage` writes it, `findBetaVoucherProblems`
 * checks a page against the same layout, and tests/scripts/beta-vouchers.test.mjs
 * holds every real beta voucher page to it. Pure functions: no I/O, no clock.
 */

import { formatLongDate } from "./beta-note.mjs";
import { AREA_BY_PREFIX } from "./areas.mjs";

export const TRACKING = "WT.mc_id=studentamb_165290";
export const BETA_EXAMS_PAGE = "/certs/vouchers/betaexams/";
// The two ways into the closed-access beta codes (the SME group of Microsoft
// Worldwide Learning), as on src/content/docs/vouchers/betaexams.mdx.
export const SME_MAILING_LIST_URL = "https://forms.office.com/r/mxZmF5fGjN";
export const SME_LINKEDIN_GROUP_URL =
  "https://www.linkedin.com/groups/13561088";

const EXAM_CODE = /^[A-Z]{2,3}-\d{3}$/;
const REAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "AZ-401" -> "az401beta": the file name (and route) of the page. */
export function betaVoucherSlug(code) {
  return `${code.toLowerCase().replace("-", "")}beta`;
}

/** The area folder of an exam code ("azure" for AZ-401), or undefined. */
export function areaOf(code) {
  return AREA_BY_PREFIX[code.split("-")[0]];
}

const escapeYaml = (text) => text.replace(/"/g, '\\"');

/**
 * The MDX of a beta voucher page. Every field is required except `scheduleUrl`.
 *
 *   code            AZ-401
 *   examName        Designing and Implementing Microsoft Agentic DevOps Solutions
 *   certification   Microsoft Certified: Agentic DevOps Engineer Expert
 *   about           what the exam validates and who it is for, from the announcement
 *   announcementUrl the Skills Hub post
 *   discountCode    the code of the post
 *   deadline        YYYY-MM-DD, the last day to take the exam at the discount
 *   registerUrl     where to register (the Learn exam or certification page)
 *   scheduleUrl     a working Pearson VUE scheduling link, only when it is needed
 */
export function buildBetaVoucherPage({
  code,
  examName,
  certification,
  about,
  announcementUrl,
  discountCode,
  deadline,
  registerUrl,
  scheduleUrl,
}) {
  const area = areaOf(code);
  const when = formatLongDate(deadline);
  const description = `Get 80% off the new Exam ${code} (beta) for ${certification}.`;
  const caution = scheduleUrl
    ? `:::caution
To schedule Exam ${code} (beta) through Pearson VUE, use [this scheduling link](${scheduleUrl}).
:::

`
    : "";

  return `---
title: Exam ${code} (beta)
description: "${escapeYaml(description)}"
voucherCategory: "Special"
voucherEnds: ${deadline}
linkedExam: ${code}
---
import { LinkButton, LinkCard, Steps } from '@components/docs';

:::tip
**Missed the public code?** There is a second, more private 80% beta code for another 300 people, shared through the SME [mailing list](${SME_MAILING_LIST_URL}) and [LinkedIn group](${SME_LINKEDIN_GROUP_URL}). Because it is not public, it tends to last much longer. See the [Beta Exams](${BETA_EXAMS_PAGE}) page for how to get access.
:::

<LinkButton href="${announcementUrl}" variant="primary" target="_blank">Read Official Announcement</LinkButton>

:::note
The first 300 people who take Exam ${code} (beta) on or before ${when}, can get 80% off market price using code **${discountCode}**.
:::

Exam ${code}: ${examName} is the new beta exam for ${certification}. ${about}

## How to claim the 80% discount

<Steps>

1. Register for [Exam ${code} (beta)](${registerUrl}).
2. Schedule to take the exam on or before **${when}**.
3. When prompted for payment, use the code **${discountCode}** to receive the 80% discount.

</Steps>

${caution}<LinkCard title="Exam ${code} Study Materials" href="/certs/${area}/${code.toLowerCase()}/" />

:::tip
This is not a private access code. The seats are offered on a first-come, first-served basis to the first 300 people. This discount is not available in Turkey, Pakistan, India, or China.
:::

Want to learn more about how beta exams work, their incentives, and what to expect? Read our dedicated beta exams page.

<LinkButton href="${BETA_EXAMS_PAGE}" variant="secondary">More About Beta Exams</LinkButton>
`;
}

// ---------------------------------------------------------------------------
// The layout check
// ---------------------------------------------------------------------------

const lf = (text) => text.replace(/\r\n/g, "\n");

/** The frontmatter as { key: value } (values as written, quotes kept), or null. */
function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2];
  }
  return { fields, end: match[0].length };
}

function realDay(value) {
  if (!REAL_DAY.test(value ?? "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * What is wrong with a beta voucher page, as a list of plain sentences (empty
 * when it follows the layout of buildBetaVoucherPage). It checks the parts that
 * make the page informative and consistent, not the exact words of the intro.
 */
export function findBetaVoucherProblems(mdxText) {
  const text = lf(mdxText);
  const problems = [];
  const front = frontmatterOf(text);
  if (!front) return ["the page has no frontmatter"];
  const { fields } = front;
  const body = text.slice(front.end);

  const title = /^Exam ([A-Z]{2,3}-\d{3}) \(beta\)$/.exec(fields.title ?? "");
  if (!title) {
    return [
      `title must be "Exam <CODE> (beta)" (got ${JSON.stringify(fields.title ?? null)})`,
    ];
  }
  const code = title[1];
  const area = areaOf(code);
  if (!area) problems.push(`the exam code ${code} has no area`);

  if (!/^".*"$/.test(fields.description ?? "")) {
    problems.push(
      "description must be a quoted string (a colon in an unquoted description breaks the page)",
    );
  } else if (!fields.description.includes(`Exam ${code} (beta)`)) {
    problems.push(`description must mention "Exam ${code} (beta)"`);
  }
  if (fields.voucherCategory !== '"Special"')
    problems.push('voucherCategory must be "Special"');
  if (!realDay(fields.voucherEnds))
    problems.push(
      "voucherEnds must be the last day of the offer, a real YYYY-MM-DD day",
    );
  if (fields.linkedExam !== code) problems.push(`linkedExam must be ${code}`);

  if (
    !/^import \{ LinkButton, LinkCard, Steps \} from '@components\/docs';$/m.test(
      body,
    )
  ) {
    problems.push(
      "the import line must be: import { LinkButton, LinkCard, Steps } from '@components/docs';",
    );
  }
  if (/\/en-us\//.test(body))
    problems.push("a link has an /en-us/ locale segment");

  // The parts, in order. Each is [label, a test of the text from the previous part on].
  const when = realDay(fields.voucherEnds)
    ? formatLongDate(fields.voucherEnds)
    : null;
  const noteMatch = new RegExp(
    `:::note\\nThe first 300 people who take Exam ${code} \\(beta\\) on or before ([A-Z][a-z]+ \\d{1,2}, \\d{4}), can get 80% off market price using code \\*\\*([A-Za-z0-9-]+)\\*\\*\\.\\n:::`,
  ).exec(body);
  const discountCode = noteMatch?.[2];
  const parts = [
    [
      "the top tip about the SME mailing list and LinkedIn group",
      new RegExp(
        `:::tip\\n[^\\n]*${escapeRe(SME_MAILING_LIST_URL)}[^\\n]*${escapeRe(SME_LINKEDIN_GROUP_URL)}[^\\n]*\\(${escapeRe(BETA_EXAMS_PAGE)}\\)[^\\n]*\\n:::`,
      ),
    ],
    [
      'the "Read Official Announcement" button',
      new RegExp(
        `<LinkButton href="https://[^"]+\\?${escapeRe(TRACKING)}" variant="primary" target="_blank">Read Official Announcement</LinkButton>`,
      ),
    ],
    [
      `the offer note ("The first 300 people who take Exam ${code} (beta) on or before <date>, can get 80% off market price using code **<CODE>**.")`,
      new RegExp(escapeRe(noteMatch?.[0] ?? "\u0000no-note")),
    ],
    [
      `the intro "Exam ${code}: <name> is the new beta exam for <certification>. <what it validates>"`,
      new RegExp(
        `\\nExam ${code}: [^\\n]+ is the new beta exam for [^\\n]+\\. [^\\n]+\\n`,
      ),
    ],
    [
      "the heading ## How to claim the 80% discount",
      /\n## How to claim the 80% discount\n/,
    ],
    [
      "the three numbered steps in <Steps>",
      new RegExp(
        `<Steps>\\n\\n1\\. Register for \\[Exam ${code} \\(beta\\)\\]\\(https://learn\\.microsoft\\.com/[^)\\s]+\\?${escapeRe(TRACKING)}\\)\\.\\n2\\. Schedule to take the exam on or before \\*\\*([A-Z][a-z]+ \\d{1,2}, \\d{4})\\*\\*\\.\\n3\\. When prompted for payment, use the code \\*\\*([A-Za-z0-9-]+)\\*\\* to receive the 80% discount\\.\\n\\n</Steps>`,
      ),
    ],
  ];
  const optional = new RegExp(
    `:::caution\\nTo schedule Exam ${code} \\(beta\\) through Pearson VUE, use \\[this scheduling link\\]\\(https://learn\\.microsoft\\.com/credentials/certifications/schedule-through-pearson-vue\\?examUid=exam\\.${code}&examUrl=[^)\\s]+\\)\\.\\n:::`,
  );
  const tail = [
    [
      `the study materials card <LinkCard title="Exam ${code} Study Materials" href="/certs/${area}/${code.toLowerCase()}/" />`,
      new RegExp(
        `<LinkCard title="Exam ${code} Study Materials" href="/certs/${area}/${code.toLowerCase()}/" />`,
      ),
    ],
    [
      'the closing tip ("This is not a private access code. ...")',
      /:::tip\nThis is not a private access code\. The seats are offered on a first-come, first-served basis to the first 300 people\. This discount is not available in Turkey, Pakistan, India, or China\.\n:::/,
    ],
    [
      'the "More About Beta Exams" secondary button',
      new RegExp(
        `<LinkButton href="${escapeRe(BETA_EXAMS_PAGE)}" variant="secondary">More About Beta Exams</LinkButton>`,
      ),
    ],
  ];

  let from = 0;
  const walk = (list) => {
    for (const [label, pattern] of list) {
      const match = pattern.exec(body.slice(from));
      if (!match) {
        problems.push(
          body.search(pattern) >= 0
            ? `${label} is out of order`
            : `missing ${label}`,
        );
        continue;
      }
      from += match.index + match[0].length;
      if (label.startsWith("the offer note") && when && noteMatch[1] !== when) {
        problems.push(
          `the offer note says ${noteMatch[1]} but voucherEnds is ${fields.voucherEnds} (${when})`,
        );
      }
      if (label.startsWith("the three numbered steps")) {
        if (when && match[1] !== when)
          problems.push(
            `step 2 says ${match[1]} but voucherEnds is ${fields.voucherEnds} (${when})`,
          );
        if (discountCode && match[2] !== discountCode)
          problems.push(
            `step 3 uses the code ${match[2]} but the offer note says ${discountCode}`,
          );
      }
    }
  };
  walk(parts);
  const caution = optional.exec(body.slice(from));
  if (caution) from += caution.index + caution[0].length;
  else if (/schedule-through-pearson-vue/.test(body.slice(from))) {
    problems.push(
      `the scheduling caution must be ":::caution / To schedule Exam ${code} (beta) through Pearson VUE, use [this scheduling link](https://learn.microsoft.com/credentials/certifications/schedule-through-pearson-vue?examUid=exam.${code}&examUrl=...). / :::" between the steps and the study materials card`,
    );
  }
  walk(tail);
  return problems;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { EXAM_CODE, REAL_DAY };

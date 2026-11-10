// Small study guides in the shape the New Exam Monitor stores (`studyGuides[].lines`): one string per
// line, headings as `## Title`, bullets as `- text`. Modelled on the real pages (AB-100, DP-700,
// DP-600) but trimmed to a few skills, so the tests read in a sentence. Not data of the site.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-11-16" -> "November 16, 2026" */
export function longDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

export const AUDIENCE = [
  "### Audience profile",
  "As a candidate for this exam, you build and run data solutions on Azure.",
  "Your competencies include:",
  "- Designing data pipelines.",
  "- Monitoring and tuning workloads.",
];

/**
 * The lines of one guide.
 * `asOf`: YYYY-MM-DD or null (an undated heading). `domains`: `[{ title, min, max, groups:
 * [{ title, tasks: [text] }] }]`. `audience`: the audience profile lines (default `AUDIENCE`).
 */
export function guide({ asOf = null, domains, audience = AUDIENCE }) {
  const heading = asOf
    ? `## Skills measured as of ${longDate(asOf)}`
    : "## Skills measured";
  const weight = (d) => `${d.title} (${d.min}–${d.max}%)`;
  return [
    heading,
    ...audience,
    "### Skills at a glance",
    ...domains.map((d) => `- ${weight(d)}`),
    ...domains.flatMap((d) => [
      `### ${weight(d)}`,
      ...d.groups.flatMap((g) => [
        `#### ${g.title}`,
        ...g.tasks.map((task) => `- ${task}`),
      ]),
    ]),
  ];
}

/** The same guide with a section Microsoft keeps for the previous version: "## Skills measured prior to <date>". */
export function withPriorSection(lines, { asOf, domains }) {
  const prior = guide({ asOf: null, domains });
  prior[0] = `## Skills measured prior to ${longDate(asOf)}`;
  return [...lines, ...prior];
}

export const BASE_DOMAINS = [
  {
    title: "Implement and manage an analytics solution",
    min: 30,
    max: 35,
    groups: [
      {
        title: "Configure workspace settings",
        tasks: [
          "Configure Spark workspace settings",
          "Configure domain workspace settings",
          "Configure OneLake workspace settings",
        ],
      },
      {
        title: "Implement lifecycle management",
        tasks: [
          "Configure version control",
          "Implement database projects",
          "Create and configure deployment pipelines",
        ],
      },
    ],
  },
  {
    title: "Ingest and transform data",
    min: 30,
    max: 35,
    groups: [
      {
        title: "Design and implement loading patterns",
        tasks: [
          "Design and implement full and incremental data loads",
          "Prepare data for loading into a dimensional model",
          "Design and implement a loading pattern for streaming data",
        ],
      },
    ],
  },
  {
    title: "Monitor and optimize an analytics solution",
    min: 30,
    max: 35,
    groups: [
      {
        title: "Monitor Fabric items",
        tasks: [
          "Monitor data ingestion",
          "Monitor data transformation",
          "Monitor semantic model refresh",
        ],
      },
    ],
  },
];

/** A deep copy of `BASE_DOMAINS` with `edit` applied to it. */
export function domains(edit = () => {}) {
  const copy = structuredClone(BASE_DOMAINS);
  edit(copy);
  return copy;
}

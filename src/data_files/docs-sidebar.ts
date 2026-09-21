import { readdirSync } from "node:fs";
import path from "node:path";
import { examStatuses } from "./exam-status.mjs";
import { docsPath } from "@utils/docs";

export interface DocsSidebarBadge {
  text: string;
  variant: "note" | "tip" | "success" | "caution" | "danger";
}

export interface DocsSidebarItem {
  label: string;
  href?: string;
  badge?: DocsSidebarBadge;
  children?: DocsSidebarItem[];
  collapsed?: boolean;
}

const areaPrefixOrder: Record<string, string[]> = {
  azure: ["AZ", "AI", "DP"],
  github: ["GH"],
  aibusiness: ["AB"],
  microsoft365: ["MD", "MS"],
  security: ["SC"],
  power: ["PL"],
  dynamics: ["MB"],
};

function buildExamItems(area: keyof typeof examStatuses): DocsSidebarItem[] {
  const docsDir = path.resolve(process.cwd(), "src", "content", "docs", area);
  const prefixOrder = areaPrefixOrder[area] ?? [];
  const statuses = examStatuses[area] as Record<string, DocsSidebarBadge>;
  const codes = readdirSync(docsDir)
    .filter((entry) => entry.toLowerCase().endsWith(".mdx"))
    .map((entry) => entry.replace(/\.mdx$/i, "").toUpperCase())
    .filter((code) => /^[A-Z]{2,3}-\d{3}$/.test(code))
    .sort((left, right) => {
      const leftRank = prefixOrder.indexOf(left.split("-")[0]);
      const rightRank = prefixOrder.indexOf(right.split("-")[0]);
      if (leftRank !== rightRank) {
        return (leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank) -
          (rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank);
      }
      return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
    });

  return codes.map((code) => ({
    label: code,
    href: docsPath(`${area}/${code}`),
    ...(statuses[code] ? { badge: statuses[code] } : {}),
  }));
}

function buildLabItems(area: string): DocsSidebarItem[] {
  const docsDir = path.resolve(process.cwd(), "src", "content", "docs", "labs", area);
  const codes = readdirSync(docsDir)
    .filter((entry) => entry.toLowerCase().endsWith(".mdx"))
    .map((entry) => entry.replace(/\.mdx$/i, ""))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));

  return codes.map((code) => ({
    label: code.toUpperCase(),
    href: docsPath(`labs/${area}/${code}`),
  }));
}

const guideItems: DocsSidebarItem[] = [
  { label: "Markdown", href: docsPath("guide/markdown") },
  { label: "Introduction", href: docsPath("guide/introduction") },
  { label: "Overview", href: docsPath("guide/overview") },
  { label: "Scheduling an Exam", href: docsPath("guide/schedulingexam") },
  { label: "Certification Dashboard", href: docsPath("guide/certificationdashboard") },
  { label: "Exam Experience", href: docsPath("guide/takingtheexams") },
  { label: "Opportunities for Students", href: docsPath("guide/studentopportunities") },
  { label: "Certification Renewal", href: docsPath("guide/certificationrenewal") },
  { label: "Microsoft Partner Employees", href: docsPath("guide/partneremployees") },
];

const prepareItems: DocsSidebarItem[] = [
  { label: "Navigating Study Materials", href: docsPath("prepare/studymaterials") },
  { label: "Business Exams", href: docsPath("prepare/business") },
  { label: "Fundamentals Exams", href: docsPath("prepare/fundamentals") },
  { label: "Role-Based Exams", href: docsPath("prepare/role-based") },
  { label: "How to Lab", href: docsPath("prepare/labs") },
];

const voucherItems: DocsSidebarItem[] = [
  { label: "Exam AB-650 (beta)", href: docsPath("vouchers/ab650beta"), badge: { text: "*80%", variant: "tip" } },
  { label: "Microsoft Defender Sweepstakes", href: docsPath("vouchers/defendersweepstakes"), badge: { text: "*50%", variant: "tip" } },
  { label: "Partner Certification Week", href: docsPath("vouchers/partnerweek"), badge: { text: "*100%", variant: "tip" } },
  { label: "South Africa AI Skills", href: docsPath("vouchers/southafricaaiskills"), badge: { text: "*100%", variant: "tip" } },
  { label: "Virtual Training Days", href: docsPath("vouchers/virtualtrainingdays"), badge: { text: "50%", variant: "note" } },
  { label: "Organizational Skilling (ESI)", href: docsPath("vouchers/microsoftesi"), badge: { text: "*50%", variant: "note" } },
  { label: "Microsoft x Coursera", href: docsPath("vouchers/microsoftxcoursera"), badge: { text: "*50%", variant: "note" } },
  { label: "Microsoft x Datacamp", href: docsPath("vouchers/microsoftxdatacamp"), badge: { text: "*50%", variant: "note" } },
  { label: "Beta Exams", href: docsPath("vouchers/betaexams"), badge: { text: "*80% + 25%", variant: "note" } },
  { label: "Student Discount", href: docsPath("vouchers/studentdiscount"), badge: { text: "30%/*45%", variant: "note" } },
  { label: "Replay/Retake Vouchers", href: docsPath("vouchers/mindhubreplayvoucherbundles") },
];

export const docsSidebar: DocsSidebarItem[] = [
  { label: "Certification Program Guide", children: guideItems, collapsed: false },
  { label: "How to Prepare", children: prepareItems, collapsed: true },
  { label: "Discounted Exam Vouchers", children: voucherItems, collapsed: true },
  {
    label: "Exam Study Materials",
    collapsed: false,
    children: [
      { label: "Azure", badge: { text: "AZ AI DP", variant: "note" }, children: buildExamItems("azure"), collapsed: true },
      { label: "GitHub", badge: { text: "GH", variant: "note" }, children: buildExamItems("github"), collapsed: true },
      { label: "AI Business", badge: { text: "AB", variant: "note" }, children: buildExamItems("aibusiness"), collapsed: true },
      { label: "Microsoft 365", badge: { text: "MS MD", variant: "note" }, children: buildExamItems("microsoft365"), collapsed: true },
      { label: "Security & Identity", badge: { text: "SC", variant: "note" }, children: buildExamItems("security"), collapsed: true },
      { label: "Power Platform", badge: { text: "PL", variant: "note" }, children: buildExamItems("power"), collapsed: true },
      { label: "Dynamics 365", badge: { text: "MB", variant: "note" }, children: buildExamItems("dynamics"), collapsed: true },
    ],
  },
  {
    label: "Exam Labs",
    collapsed: true,
    children: [
      { label: "Azure", children: buildLabItems("azure"), collapsed: true },
      { label: "AI Business", children: buildLabItems("aibusiness"), collapsed: true },
      { label: "Dynamics 365", children: buildLabItems("dynamics"), collapsed: true },
      { label: "GitHub", children: buildLabItems("github"), collapsed: true },
      { label: "Microsoft 365", children: buildLabItems("microsoft365"), collapsed: true },
      { label: "Power Platform", children: buildLabItems("power"), collapsed: true },
      { label: "Security & Identity", children: buildLabItems("security"), collapsed: true },
    ],
  },
  { label: "Support Us", href: docsPath("supportus") },
  { label: "Contributing", href: docsPath("contributing") },
  { label: "Privacy Policy", href: docsPath("privacy") },
];

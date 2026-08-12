import { readdirSync } from "node:fs";
import path from "node:path";
import { examStatuses } from "./exam-status.mjs";

export interface DocsSidebarBadge {
  text: string;
  variant: "note" | "tip" | "caution" | "danger";
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
    href: `/${area}/${code.toLowerCase()}/`,
    ...(statuses[code] ? { badge: statuses[code] } : {}),
  }));
}

const guideItems: DocsSidebarItem[] = [
  { label: "Markdown", href: "/wiki-next/guide/markdown/" },
  { label: "Introduction", href: "/wiki-next/guide/introduction/" },
  { label: "Overview", href: "/wiki-next/guide/overview/" },
  { label: "Scheduling an Exam", href: "/wiki-next/guide/schedulingexam/" },
  { label: "Certification Dashboard", href: "/wiki-next/guide/certificationdashboard/" },
  { label: "Exam Experience", href: "/wiki-next/guide/takingtheexams/" },
  { label: "Opportunities for Students", href: "/wiki-next/guide/studentopportunities/" },
  { label: "Certification Renewal", href: "/wiki-next/guide/certificationrenewal/" },
  { label: "Microsoft Partner Employees", href: "/wiki-next/guide/partneremployees/" },
];

const prepareItems: DocsSidebarItem[] = [
  { label: "Navigating Study Materials", href: "/prepare/studymaterials/" },
  { label: "Business Exams", href: "/prepare/business/" },
  { label: "Fundamentals Exams", href: "/prepare/fundamentals/" },
  { label: "Role-Based Exams", href: "/prepare/role-based/" },
  { label: "How to Lab", href: "/prepare/labs/" },
];

const voucherItems: DocsSidebarItem[] = [
  { label: "Exam AB-650 (beta)", href: "/vouchers/ab650beta/", badge: { text: "*80%", variant: "tip" } },
  { label: "Microsoft Defender Sweepstakes", href: "/vouchers/defendersweepstakes/", badge: { text: "*50%", variant: "tip" } },
  { label: "Partner Certification Week", href: "/vouchers/partnerweek/", badge: { text: "*100%", variant: "tip" } },
  { label: "Fabric Data Days", href: "/vouchers/fabricdatadays/", badge: { text: "100%", variant: "tip" } },
  { label: "South Africa AI Skills", href: "/vouchers/southafricaaiskills/", badge: { text: "*100%", variant: "tip" } },
  { label: "Virtual Training Days", href: "/vouchers/virtualtrainingdays/", badge: { text: "50%", variant: "note" } },
  { label: "Organizational Skilling (ESI)", href: "/vouchers/microsoftesi/", badge: { text: "*50%", variant: "note" } },
  { label: "Microsoft x Coursera", href: "/vouchers/microsoftxcoursera/", badge: { text: "*50%", variant: "note" } },
  { label: "Microsoft x Datacamp", href: "/vouchers/microsoftxdatacamp/", badge: { text: "*50%", variant: "note" } },
  { label: "Beta Exams", href: "/vouchers/betaexams/", badge: { text: "*80% + 25%", variant: "note" } },
  { label: "Student Discount", href: "/vouchers/studentdiscount/", badge: { text: "30%/*45%", variant: "note" } },
  { label: "Replay/Retake Vouchers", href: "/vouchers/mindhubreplayvoucherbundles/" },
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
  { label: "Support Us", href: "/supportus/" },
  { label: "Contributing", href: "/contributing/" },
  { label: "Privacy Policy", href: "/privacy/" },
];

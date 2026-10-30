import { readdirSync } from "node:fs";
import path from "node:path";
import { examStatuses, visibleExamStatuses } from "./exam-status.mjs";
import { docsPath } from "@utils/docs";

type DocsSidebarIcon =
  | "ph:book-open-text"
  | "ph:graduation-cap"
  | "ph:ticket"
  | "ph:books"
  | "simple-icons:microsoftazure"
  | "simple-icons:github"
  | "microsoft-copilot"
  | "simple-icons:microsoftoffice"
  | "microsoft-defender"
  | "simple-icons:powerbi"
  | "simple-icons:dynamics365";

export interface DocsSidebarBadge {
  text: string;
  variant: "note" | "tip" | "success" | "caution" | "danger";
}

export interface DocsSidebarItem {
  label: string;
  href?: string;
  icon?: DocsSidebarIcon;
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

// The statuses as of this build: a NEW badge that has run its 90 days is left out.
const shownStatuses = visibleExamStatuses();

function buildExamItems(area: keyof typeof examStatuses): DocsSidebarItem[] {
  const docsDir = path.resolve(process.cwd(), "src", "content", "docs", area);
  const prefixOrder = areaPrefixOrder[area] ?? [];
  const statuses = shownStatuses[area] as Record<string, DocsSidebarBadge>;
  const codes = readdirSync(docsDir)
    .filter((entry) => entry.toLowerCase().endsWith(".mdx"))
    .map((entry) => entry.replace(/\.mdx$/i, "").toUpperCase())
    .filter((code) => /^[A-Z]{2,3}-\d{3}$/.test(code))
    .sort((left, right) => {
      const leftRank = prefixOrder.indexOf(left.split("-")[0]);
      const rightRank = prefixOrder.indexOf(right.split("-")[0]);
      if (leftRank !== rightRank) {
        return (
          (leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank) -
          (rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank)
        );
      }
      return left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  return codes.map((code) => ({
    label: code,
    href: docsPath(`${area}/${code}`),
    ...(statuses[code] ? { badge: statuses[code] } : {}),
  }));
}

const guideItems: DocsSidebarItem[] = [
  { label: "Introduction", href: docsPath("guide/introduction") },
  { label: "Overview", href: docsPath("guide/overview") },
  { label: "Scheduling an Exam", href: docsPath("guide/schedulingexam") },
  {
    label: "Certification Dashboard",
    href: docsPath("guide/certificationdashboard"),
  },
  { label: "Exam Experience", href: docsPath("guide/takingtheexams") },
  {
    label: "Opportunities for Students",
    href: docsPath("guide/studentopportunities"),
  },
  {
    label: "Certification Renewal",
    href: docsPath("guide/certificationrenewal"),
  },
  {
    label: "Microsoft Partner Employees",
    href: docsPath("guide/partneremployees"),
  },
];

const prepareItems: DocsSidebarItem[] = [
  {
    label: "Navigating Study Materials",
    href: docsPath("prepare/studymaterials"),
    badge: { text: "WIP", variant: "caution" },
  },
  { label: "Business Exams", href: docsPath("prepare/business") },
  { label: "Fundamentals Exams", href: docsPath("prepare/fundamentals") },
  { label: "Role-Based Exams", href: docsPath("prepare/role-based") },
  { label: "How to Lab", href: docsPath("prepare/labs") },
];

const voucherItems: DocsSidebarItem[] = [
  {
    label: "Partner LevelUp",
    href: docsPath("vouchers/levelup"),
    badge: { text: "*100%", variant: "tip" },
  },
  {
    label: "Exam AB-330 (beta)",
    href: docsPath("vouchers/ab330beta"),
    badge: { text: "*80%", variant: "tip" },
  },
  {
    label: "Exam AZ-401 (beta)",
    href: docsPath("vouchers/az401beta"),
    badge: { text: "*80%", variant: "tip" },
  },
  {
    label: "Exam GH-700 (beta)",
    href: docsPath("vouchers/gh700beta"),
    badge: { text: "*80%", variant: "tip" },
  },
  {
    label: "Partner Certification Week",
    href: docsPath("vouchers/partnerweek"),
    badge: { text: "*100%", variant: "tip" },
  },
  {
    label: "South Africa AI Skills",
    href: docsPath("vouchers/southafricaaiskills"),
    badge: { text: "*100%", variant: "tip" },
  },
  {
    label: "Organizational Skilling (ESI)",
    href: docsPath("vouchers/microsoftesi"),
    badge: { text: "*50%", variant: "note" },
  },
  {
    label: "Microsoft x Coursera",
    href: docsPath("vouchers/microsoftxcoursera"),
    badge: { text: "*50%", variant: "note" },
  },
  {
    label: "Microsoft x Datacamp",
    href: docsPath("vouchers/microsoftxdatacamp"),
    badge: { text: "*50%", variant: "note" },
  },
  {
    label: "Beta Exams",
    href: docsPath("vouchers/betaexams"),
    badge: { text: "*80% + 25%", variant: "note" },
  },
  {
    label: "Student Discount",
    href: docsPath("vouchers/studentdiscount"),
    badge: { text: "30%/*45%", variant: "note" },
  },
  {
    label: "Replay/Retake Vouchers",
    href: docsPath("vouchers/mindhubreplayvoucherbundles"),
  },
];

export const docsSidebar: DocsSidebarItem[] = [
  {
    label: "Certification Program Guide",
    icon: "ph:book-open-text",
    children: guideItems,
    collapsed: false,
  },
  {
    label: "How to Prepare",
    icon: "ph:graduation-cap",
    children: prepareItems,
    collapsed: true,
  },
  {
    label: "Discounted Exam Vouchers",
    icon: "ph:ticket",
    children: voucherItems,
    collapsed: false,
  },
  {
    label: "Exam Study Materials",
    icon: "ph:books",
    collapsed: false,
    children: [
      {
        label: "Azure",
        icon: "simple-icons:microsoftazure",
        badge: { text: "AZ AI DP", variant: "note" },
        children: buildExamItems("azure"),
        collapsed: true,
      },
      {
        label: "GitHub",
        icon: "simple-icons:github",
        badge: { text: "GH", variant: "note" },
        children: buildExamItems("github"),
        collapsed: true,
      },
      {
        label: "AI Business",
        icon: "microsoft-copilot",
        badge: { text: "AB", variant: "note" },
        children: buildExamItems("aibusiness"),
        collapsed: true,
      },
      {
        label: "Microsoft 365",
        icon: "simple-icons:microsoftoffice",
        badge: { text: "MS MD", variant: "note" },
        children: buildExamItems("microsoft365"),
        collapsed: true,
      },
      {
        label: "Security & Identity",
        icon: "microsoft-defender",
        badge: { text: "SC", variant: "note" },
        children: buildExamItems("security"),
        collapsed: true,
      },
      {
        label: "Power Platform",
        icon: "simple-icons:powerbi",
        badge: { text: "PL", variant: "note" },
        children: buildExamItems("power"),
        collapsed: true,
      },
      {
        label: "Dynamics 365",
        icon: "simple-icons:dynamics365",
        badge: { text: "MB", variant: "note" },
        children: buildExamItems("dynamics"),
        collapsed: true,
      },
    ],
  },
  { label: "Support Us", href: docsPath("supportus") },
  { label: "Contributing", href: docsPath("contributing") },
];

function sidebarPath(href: string): string {
  const { pathname } = new URL(href, "https://msfthub.com");
  return pathname.replace(/\/+$/, "") || "/";
}

const sidebarIconByHref = new Map<string, DocsSidebarIcon>();

function indexSidebarIcons(
  items: DocsSidebarItem[],
  inheritedIcon?: DocsSidebarIcon,
): void {
  for (const item of items) {
    const icon = item.icon ?? inheritedIcon;
    if (item.href && icon) {
      sidebarIconByHref.set(sidebarPath(item.href), icon);
    }
    if (item.children) {
      indexSidebarIcons(item.children, icon);
    }
  }
}

indexSidebarIcons(docsSidebar);

export function sidebarIconForHref(href: string): string | undefined {
  return sidebarIconByHref.get(sidebarPath(href));
}

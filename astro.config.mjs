import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import starlightImageZoom from "starlight-image-zoom";
import astroIcon from "astro-icon";
import { readdirSync } from "node:fs";
import path from "node:path";
import { examStatuses } from "./src/data_files/exam-status.mjs";

const googleAnalyticsId = "G-CDTP3TERKP";
const clarityAnalyticsId = "u7pei4s9cq";
const discordUrl =
  "https://discord.gg/microsoft-certification-study-group-676990910176821270";
const googleTagManagerId = "GTM-TMNHVD5B";
const site = "https://msfthub.com/";

const examBadges = examStatuses;

const areaPrefixOrder = {
  azure: ["AZ", "AI", "DP"],
  github: ["GH"],
  aibusiness: ["AB"],
  microsoft365: ["MD", "MS"],
  security: ["SC"],
  power: ["PL"],
  dynamics: ["MB"],
};

function buildExamSidebarItems(area) {
  const docsDir = path.resolve(process.cwd(), "src", "content", "docs", area);
  const prefixOrder = areaPrefixOrder[area] ?? [];
  const badges = examBadges[area] ?? {};
  const entries = readdirSync(docsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mdx"),
    )
    .map((entry) => entry.name.replace(/\.mdx$/i, "").toUpperCase())
    .filter((code) => /^[A-Z]{2,3}-\d{3}$/.test(code))
    .sort((left, right) => {
      const leftPrefix = left.split("-")[0];
      const rightPrefix = right.split("-")[0];
      const leftRank = prefixOrder.indexOf(leftPrefix);
      const rightRank = prefixOrder.indexOf(rightPrefix);
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

  return entries.map((code) => ({
    label: code,
    link: `/${area}/${code.toLowerCase()}/`,
    ...(badges[code] ? { badge: badges[code] } : {}),
  }));
}

// https://astro.build/config
export default defineConfig({
  // https://docs.astro.build/en/guides/images/#authorizing-remote-images
  site: "https://msfthub.com",
  redirects: {
    "/guide": "/guide/introduction",
    "/microsoft365": "/wiki",
    "/azure": "/wiki",
    "/powerplatform": "/wiki",
    "/security": "/wiki",
    "/dynamics": "/wiki",

    "/ai&ab/ai-900": "/azure/ai-901",
    "/ai&ab/ai-102": "/azure/ai-103",
    "/ai&ab/ai-103": "/azure/ai-103",
    "/ai&ab/ai-300": "/azure/ai-300",
    "/ai&ab/ai-901": "/azure/ai-901",
    "/azure/dp-100": "/azure/ai-300",
    "/azure/ai-102": "/azure/ai-103",
    "/azure/ai-900": "/azure/ai-901",
    "/power/pl-600": "/aibusiness/ab-100",

    "/microsoft365/ms-900": "/aibusiness/ab-900",
    "/aiab/ab-900/": "/aibusiness/ab-900/",
    "/aiab/ab-100/": "/aibusiness/ab-100/",
    "/aiab/ab-730/": "/aibusiness/ab-730/",
    "/aiab/ab-731/": "/aibusiness/ab-731/",
    "/guide/officialstudymaterials/": "/wiki",
    "/security/sc-730/": "/security/sc-900/",
    "/vouchers/aichallenge/": "/vouchers/",
    "/vouchers/microsoftignite/": "/vouchers/",
    "/dynamics/mb-280": "/aibusiness/ab-210",
    "/azure/az-204": "/azure/ai-200",

    "/discord":
      "https://discord.com/invite/microsoft-certification-study-group-676990910176821270",
  },
  image: {
    domains: ["images.unsplash.com", "msfthub.com"],
    dangerouslyProcessSVG: true,
  },
  prefetch: true,
  integrations: [
    astroIcon(),
    sitemap({
      i18n: {
        defaultLocale: "en", // All urls that don't contain language prefix will be treated as default locale
        locales: {
          en: "en", // The `defaultLocale` value must present in `locales` keys
        },
      },
      filter: (page) => !page.includes("/news/"),
    }),
    starlight({
      title: "Microsoft Certification Hub",
      plugins: [starlightImageZoom()],
      sidebar: [
        {
          label: "Certification Program Guide",
          items: [
            { label: "Introduction", link: "/guide/introduction/" },
            { label: "Overview", link: "/guide/overview/" },
            { label: "Scheduling an Exam", link: "/guide/schedulingexam/" },
            {
              label: "Certification Dashboard",
              link: "/guide/certificationdashboard/",
            },
            { label: "Exam Experience", link: "/guide/takingtheexams/" },
            {
              label: "Opportunities for Students",
              link: "/guide/studentopportunities/",
            },
            {
              label: "Certification Renewal",
              link: "/guide/certificationrenewal/",
            },
            {
              label: "Microsoft Partner Employees",
              link: "/guide/partneremployees/",
            },
          ],
        },
        {
          label: "How to Prepare",
          items: [
            {
              label: "Navigating Study Materials",
              link: "/prepare/studymaterials/",
            },
            {
              label: "Business Exams",
              link: "/prepare/business/",
            },
            {
              label: "Fundamentals Exams",
              link: "/prepare/fundamentals/",
            },
            {
              label: "Role-Based Exams",
              link: "/prepare/role-based/",
            },
            {
              label: "How to Lab",
              link: "/prepare/labs/",
            },
          ],
        },
        {
          label: "Discounted Exam Vouchers",
          items: [
            {
              label: "Exam AB-650 (beta)",
              link: "/vouchers/ab650beta/",
              badge: { text: "*80%", variant: "tip" },
            },
            {
              label: "Microsoft Defender Sweepstakes",
              link: "/vouchers/defendersweepstakes/",
              badge: { text: "*50%", variant: "tip" },
            },
            {
              label: "Partner Certification Week",
              link: "/vouchers/partnerweek/",
              badge: { text: "*100%", variant: "tip" },
            },
            {
              label: "Fabric Data Days",
              link: "/vouchers/fabricdatadays/",
              badge: { text: "100%", variant: "tip" },
            },
            {
              label: "South Africa AI Skills",
              link: "/vouchers/southafricaaiskills/",
              badge: { text: "*100%", variant: "tip" },
            },
            {
              label: "Virtual Training Days",
              link: "/vouchers/virtualtrainingdays/",
              badge: { text: "50%", variant: "note" },
            },
            {
              label: "Organizational Skilling (ESI)",
              link: "/vouchers/microsoftesi/",
              badge: { text: "*50%", variant: "note" },
            },
            {
              label: "Microsoft x Coursera",
              link: "/vouchers/microsoftxcoursera/",
              badge: { text: "*50%", variant: "note" },
            },
            {
              label: "Microsoft x Datacamp",
              link: "/vouchers/microsoftxdatacamp/",
              badge: { text: "*50%", variant: "note" },
            },
            {
              label: "Beta Exams",
              link: "/vouchers/betaexams/",
              badge: { text: "*80% + 25%", variant: "note" },
            },
            {
              label: "Student Discount",
              link: "/vouchers/studentdiscount/",
              badge: { text: "30%/*45%", variant: "note" },
            },
            {
              label: "Replay/Retake Vouchers",
              link: "/vouchers/mindhubreplayvoucherbundles/",
            },
          ],
        },
        {
          label: "Exam Study Materials",
          collapsed: false,
          items: [
            {
              label: "Azure",
              collapsed: true,
              badge: { text: "AZ AI DP", variant: "note" },
              items: buildExamSidebarItems("azure"),
            },
            {
              label: "GitHub",
              collapsed: true,
              badge: { text: "GH", variant: "note" },
              items: buildExamSidebarItems("github"),
            },
            {
              label: "AI Business",
              badge: { text: "AB", variant: "note" },
              collapsed: true,
              items: buildExamSidebarItems("aibusiness"),
            },
            {
              label: "Microsoft 365",
              collapsed: true,
              badge: { text: "MS MD", variant: "note" },
              items: buildExamSidebarItems("microsoft365"),
            },
            {
              label: "Security & Identity",
              badge: { text: "SC", variant: "note" },
              collapsed: true,
              items: buildExamSidebarItems("security"),
            },
            {
              label: "Power Platform",
              badge: { text: "PL", variant: "note" },
              collapsed: true,
              items: buildExamSidebarItems("power"),
            },
            {
              label: "Dynamics 365",
              badge: { text: "MB", variant: "note" },
              collapsed: true,
              items: buildExamSidebarItems("dynamics"),
            },
          ],
        },
        {
          label: "Support Us",
          link: "/supportus",
        },
        {
          label: "Contributing",
          link: "/contributing",
        },
        {
          label: "Privacy Policy",
          link: "/privacy",
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/mscerts/hub",
        },
        {
          icon: "discord",
          label: "Discord",
          href: discordUrl,
        },
      ],
      disable404Route: true,
      editLink: {
        baseUrl: "https://github.com/mscerts/hub/edit/main/",
      },
      customCss: process.env.NO_GRADIENTS
        ? ["./src/custom.css"]
        : [
            "./src/landing.css",
            "./src/custom.css",
            "./src/assets/styles/starlight.css",
          ],
      logo: {
        light: "/src/assets/images/logo_light.svg",
        dark: "/src/assets/images/logo_dark.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      components: {
        SiteTitle: "./src/components/ui/starlight/SiteTitle.astro",
        Head: "./src/components/ui/starlight/Head.astro",
        MobileMenuFooter:
          "./src/components/ui/starlight/MobileMenuFooter.astro",
        TableOfContents: "./src/components/ui/starlight/TableOfContents.astro",
        PageTitle: "./src/components/ui/starlight/page-actions/PageTitle.astro",
        /* ThemeSelect: "./src/components/ui/starlight/ThemeSelect.astro", */
        MarkdownContent: "./src/components/MarkdownContent.astro",
        /* Sidebar: './src/components/Sidebar.astro', */
      },
      head: [
        {
          tag: "script",
          attrs: {
            src: `https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsId}`,
          },
        },
        {
          tag: "script",
          attrs: {
            src: `https://www.clarity.ms/tag/${clarityAnalyticsId}`,
          },
        },
        {
          tag: "script",
          content: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
  
            gtag('config', '${googleAnalyticsId}');
            `,
        },
        {
          tag: "script",
          content: `    
             (function(c,l,a,r,i,t,y){
             c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
             t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
             y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
             })(window, document, "clarity", "script", "${clarityAnalyticsId}")
            `,
        },
        {
          tag: "script",
          content: `
             (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
             new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
             j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
             'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
             })(window,document,'script','dataLayer','${googleTagManagerId}');
            `,
        },
      ],
    }),
  ],
  experimental: {
    clientPrerender: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});

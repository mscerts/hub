import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import astroIcon from "astro-icon";
import remarkDirective from "remark-directive";
import remarkCallouts from "./src/utils/markdown/remark-callouts.mjs";

const legacyDocsPrefixes = [
  "aibusiness",
  "azure",
  "contributing",
  "courses",
  "dynamics",
  "github",
  "guide",
  "labs",
  "microsoft365",
  "office",
  "power",
  "prepare",
  "security",
  "supportus",
  "vouchers",
  "welcome",
];

export default defineConfig({
  site: "https://msfthub.com",
  redirects: {
    "/guide": "/certs/guide/introduction/",
    "/microsoft365": "/certs/",
    "/azure": "/certs/",
    "/powerplatform": "/certs/",
    "/security": "/certs/",
    "/dynamics": "/certs/",
    "/ai&ab/ai-900": "/certs/azure/ai-901/",
    "/ai&ab/ai-102": "/certs/azure/ai-103/",
    "/ai&ab/ai-103": "/certs/azure/ai-103/",
    "/ai&ab/ai-300": "/certs/azure/ai-300/",
    "/ai&ab/ai-901": "/certs/azure/ai-901/",
    "/azure/dp-100": "/certs/azure/ai-300/",
    "/azure/ai-102": "/certs/azure/ai-103/",
    "/azure/ai-900": "/certs/azure/ai-901/",
    "/power/pl-600": "/certs/aibusiness/ab-100/",
    "/power/pl-200": "/certs/aibusiness/ab-410/",
    "/power/pl-200/": "/certs/aibusiness/ab-410/",
    "/labs/power/pl-200": "/certs/labs/aibusiness/ab-410/",
    "/labs/power/pl-200/": "/certs/labs/aibusiness/ab-410/",
    "/azure/az-500": "/certs/security/sc-500/",
    "/azure/az-500/": "/certs/security/sc-500/",
    "/labs/azure/az-500": "/certs/labs/security/sc-500/",
    "/labs/azure/az-500/": "/certs/labs/security/sc-500/",
    "/microsoft365/ms-900": "/certs/aibusiness/ab-900/",
    "/aiab/ab-900/": "/certs/aibusiness/ab-900/",
    "/aiab/ab-100/": "/certs/aibusiness/ab-100/",
    "/aiab/ab-730/": "/certs/aibusiness/ab-730/",
    "/aiab/ab-731/": "/certs/aibusiness/ab-731/",
    "/guide/officialstudymaterials/": "/certs/",
    "/security/sc-730/": "/certs/security/sc-900/",
    "/vouchers/aichallenge/": "/certs/vouchers/",
    "/vouchers/microsoftignite/": "/certs/vouchers/",
    "/vouchers/fabricdatadays/": "/certs/vouchers/",
    "/dynamics/mb-280": "/certs/aibusiness/ab-210/",
    "/azure/az-204": "/certs/azure/ai-200/",
    "/discord":
      "https://discord.com/invite/microsoft-certification-study-group-676990910176821270",
  },
  image: {
    domains: ["images.unsplash.com", "msfthub.com"],
    dangerouslyProcessSVG: true,
  },
  markdown: {
    processor: unified({ remarkPlugins: [remarkDirective, remarkCallouts] }),
  },
  prefetch: true,
  integrations: [
    mdx(),
    astroIcon(),
    sitemap({
      i18n: {
        defaultLocale: "en",
        locales: { en: "en" },
      },
      filter: (page) => {
        const pathname = new URL(page).pathname;
        const isLegacyDoc = legacyDocsPrefixes.some(
          (prefix) =>
            pathname === `/${prefix}/` || pathname.startsWith(`/${prefix}/`),
        );

        return (
          !pathname.startsWith("/wiki/") &&
          !pathname.startsWith("/wiki-next/") &&
          !pathname.endsWith(".md") &&
          !isLegacyDoc
        );
      },
    }),
  ],
  experimental: {
    clientPrerender: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});

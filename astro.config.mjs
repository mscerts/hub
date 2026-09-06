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
    "/guide": "/wiki/guide/introduction/",
    "/microsoft365": "/wiki/",
    "/azure": "/wiki/",
    "/powerplatform": "/wiki/",
    "/security": "/wiki/",
    "/dynamics": "/wiki/",
    "/ai&ab/ai-900": "/wiki/azure/ai-901/",
    "/ai&ab/ai-102": "/wiki/azure/ai-103/",
    "/ai&ab/ai-103": "/wiki/azure/ai-103/",
    "/ai&ab/ai-300": "/wiki/azure/ai-300/",
    "/ai&ab/ai-901": "/wiki/azure/ai-901/",
    "/azure/dp-100": "/wiki/azure/ai-300/",
    "/azure/ai-102": "/wiki/azure/ai-103/",
    "/azure/ai-900": "/wiki/azure/ai-901/",
    "/power/pl-600": "/wiki/aibusiness/ab-100/",
    "/microsoft365/ms-900": "/wiki/aibusiness/ab-900/",
    "/aiab/ab-900/": "/wiki/aibusiness/ab-900/",
    "/aiab/ab-100/": "/wiki/aibusiness/ab-100/",
    "/aiab/ab-730/": "/wiki/aibusiness/ab-730/",
    "/aiab/ab-731/": "/wiki/aibusiness/ab-731/",
    "/guide/officialstudymaterials/": "/wiki/",
    "/security/sc-730/": "/wiki/security/sc-900/",
    "/vouchers/aichallenge/": "/wiki/vouchers/",
    "/vouchers/microsoftignite/": "/wiki/vouchers/",
    "/dynamics/mb-280": "/wiki/aibusiness/ab-210/",
    "/azure/az-204": "/wiki/azure/ai-200/",
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
          (prefix) => pathname === `/${prefix}/` || pathname.startsWith(`/${prefix}/`),
        );

        return (
          !pathname.startsWith("/news/") &&
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

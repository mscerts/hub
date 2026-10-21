import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import astroIcon from "astro-icon";
import remarkDirective from "remark-directive";
import remarkCallouts from "./src/utils/markdown/remark-callouts.mjs";
import rehypeWrapTables from "./src/utils/markdown/rehype-wrap-tables.mjs";
import deploymentRedirects from "./src/utils/deployment-redirects.mjs";

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
    "/certs/privacy": "/privacy/",
    "/certs/privacy.md": "/privacy/",
    "/privacy.md": "/privacy/",
    "/wiki/privacy": "/privacy/",
    "/wiki/privacy.md": "/privacy/",
    "/wiki-next/privacy": "/privacy/",
    "/wiki-next/privacy.md": "/privacy/",
    "/guide": "/certs/guide/introduction/",
    "/vouchers/ab650beta/": "/certs/archive/vouchers/ab650beta/",
    "/azure/az-800": "/certs/archive/azure/az-800/",
    "/azure/az-801": "/certs/archive/azure/az-801/",
    "/dynamics/mb-240": "/certs/archive/dynamics/mb-240/",
    "/power/pl-500": "/certs/archive/power/pl-500/",
    "/certs/azure/az-800/": "/certs/archive/azure/az-800/",
    "/certs/azure/az-800.md": "/certs/archive/azure/az-800/",
    "/certs/azure/az-801/": "/certs/archive/azure/az-801/",
    "/certs/azure/az-801.md": "/certs/archive/azure/az-801/",
    "/certs/labs/azure/az-800/": "/certs/archive/labs/azure/az-800/",
    "/certs/labs/azure/az-800.md": "/certs/archive/labs/azure/az-800/",
    "/certs/labs/azure/az-801/": "/certs/archive/labs/azure/az-801/",
    "/certs/labs/azure/az-801.md": "/certs/archive/labs/azure/az-801/",
    "/certs/azure/az-204/": "/certs/archive/azure/az-204/",
    "/certs/azure/az-204.md": "/certs/archive/azure/az-204/",
    "/certs/azure/ai-102/": "/certs/archive/azure/ai-102/",
    "/certs/azure/ai-102.md": "/certs/archive/azure/ai-102/",
    "/certs/azure/ai-900/": "/certs/archive/azure/ai-900/",
    "/certs/azure/ai-900.md": "/certs/archive/azure/ai-900/",
    "/certs/azure/az-500/": "/certs/archive/azure/az-500/",
    "/certs/azure/az-500.md": "/certs/archive/azure/az-500/",
    "/certs/dynamics/mb-240/": "/certs/archive/dynamics/mb-240/",
    "/certs/dynamics/mb-240.md": "/certs/archive/dynamics/mb-240/",
    "/certs/dynamics/mb-280/": "/certs/archive/dynamics/mb-280/",
    "/certs/dynamics/mb-280.md": "/certs/archive/dynamics/mb-280/",
    "/certs/power/pl-200/": "/certs/archive/power/pl-200/",
    "/certs/power/pl-200.md": "/certs/archive/power/pl-200/",
    "/certs/power/pl-500/": "/certs/archive/power/pl-500/",
    "/certs/power/pl-500.md": "/certs/archive/power/pl-500/",
    "/certs/power/pl-600/": "/certs/archive/power/pl-600/",
    "/certs/power/pl-600.md": "/certs/archive/power/pl-600/",
    "/certs/security/sc-730/": "/certs/archive/security/sc-730/",
    "/certs/security/sc-730.md": "/certs/archive/security/sc-730/",
    "/certs/vouchers/fabricdatadays/":
      "/certs/archive/vouchers/fabricdatadays/",
    "/certs/vouchers/fabricdatadays.md":
      "/certs/archive/vouchers/fabricdatadays/",
    "/certs/vouchers/aiagentskillssweepstakes/":
      "/certs/archive/vouchers/aiagentskillssweepstakes/",
    "/certs/vouchers/aiagentskillssweepstakes.md":
      "/certs/archive/vouchers/aiagentskillssweepstakes/",
    "/certs/vouchers/defendersweepstakes/":
      "/certs/archive/vouchers/defendersweepstakes/",
    "/certs/vouchers/defendersweepstakes.md":
      "/certs/archive/vouchers/defendersweepstakes/",
    "/certs/vouchers/getsqlaidevelopercertified/":
      "/certs/archive/vouchers/getsqlaidevelopercertified/",
    "/certs/vouchers/getsqlaidevelopercertified.md":
      "/certs/archive/vouchers/getsqlaidevelopercertified/",
    "/certs/vouchers/ab650beta/": "/certs/archive/vouchers/ab650beta/",
    "/certs/vouchers/ab650beta.md": "/certs/archive/vouchers/ab650beta/",
    "/certs/vouchers/ai500beta/": "/certs/archive/vouchers/ai500beta/",
    "/certs/vouchers/ai500beta.md": "/certs/archive/vouchers/ai500beta/",
    "/certs/vouchers/az802beta/": "/certs/archive/vouchers/az802beta/",
    "/certs/vouchers/az802beta.md": "/certs/archive/vouchers/az802beta/",
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
    "/azure/ai-102": "/certs/archive/azure/ai-102/",
    "/azure/ai-900": "/certs/archive/azure/ai-900/",
    "/power/pl-400": "/certs/aibusiness/ab-400/",
    "/labs/power/pl-400": "/certs/labs/aibusiness/ab-400/",
    "/certs/power/pl-400": "/certs/aibusiness/ab-400/",
    "/certs/labs/power/pl-400": "/certs/labs/aibusiness/ab-400/",
    "/power/pl-600": "/certs/archive/power/pl-600/",
    "/power/pl-200": "/certs/archive/power/pl-200/",
    "/labs/power/pl-200": "/certs/labs/aibusiness/ab-410/",
    "/azure/az-500": "/certs/archive/azure/az-500/",
    "/labs/azure/az-500": "/certs/labs/security/sc-500/",
    "/microsoft365/ms-900": "/certs/aibusiness/ab-900/",
    "/aiab/ab-900/": "/certs/aibusiness/ab-900/",
    "/aiab/ab-100/": "/certs/aibusiness/ab-100/",
    "/aiab/ab-730/": "/certs/aibusiness/ab-730/",
    "/aiab/ab-731/": "/certs/aibusiness/ab-731/",
    "/guide/officialstudymaterials/": "/certs/",
    "/guide/howtoprepare/": "/certs/prepare/studymaterials/",
    "/security/sc-730/": "/certs/security/sc-900/",
    "/vouchers/aichallenge/": "/certs/vouchers/",
    "/vouchers/microsoftignite/": "/certs/vouchers/",
    "/vouchers/fabricdatadays/": "/certs/archive/vouchers/fabricdatadays/",
    "/vouchers/defendersweepstakes/":
      "/certs/archive/vouchers/defendersweepstakes/",
    "/vouchers/aiagentskillssweepstakes/":
      "/certs/archive/vouchers/aiagentskillssweepstakes/",
    "/vouchers/getsqlaidevelopercertified/":
      "/certs/archive/vouchers/getsqlaidevelopercertified/",
    "/vouchers/ai500beta/": "/certs/archive/vouchers/ai500beta/",
    "/vouchers/az802beta/": "/certs/archive/vouchers/az802beta/",
    "/dynamics/mb-280": "/certs/archive/dynamics/mb-280/",
    "/azure/az-204": "/certs/archive/azure/az-204/",
    "/security/sc-730/": "/certs/archive/security/sc-730/",
    "/discord":
      "https://discord.com/invite/microsoft-certification-study-group-676990910176821270",
  },
  image: {
    domains: ["images.unsplash.com", "msfthub.com"],
    dangerouslyProcessSVG: true,
  },
  markdown: {
    processor: unified({
      remarkPlugins: [remarkDirective, remarkCallouts],
      rehypePlugins: [rehypeWrapTables],
    }),
  },
  prefetch: true,
  integrations: [
    mdx(),
    astroIcon(),
    deploymentRedirects(),
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
          pathname !== "/certs/privacy/" &&
          !pathname.startsWith("/wiki/") &&
          !pathname.startsWith("/wiki-next/") &&
          !(
            pathname.startsWith("/certs/archive/") &&
            pathname !== "/certs/archive/"
          ) &&
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

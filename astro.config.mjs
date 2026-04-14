import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import compressor from "astro-compressor";
import starlight from "@astrojs/starlight";
import starlightImageZoom from "starlight-image-zoom";
import partytown from "@astrojs/partytown";
import { viewTransitions } from "astro-vtbot/starlight-view-transitions";
import mdx from "@astrojs/mdx";

const googleAnalyticsId = "G-CDTP3TERKP";
const clarityAnalyticsId = "u7pei4s9cq";
const googleTagManagerId = "GTM-TMNHVD5B";
const site = "https://msfthub.com/";

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
    "/azure/ai-900": "/aiab/ai-900",
    "/azure/ai-102": "/aiab/ai-102",
    "/microsoft365/ms-900": "/aiab/ab-900",
    "/discord":
      "https://discord.com/invite/microsoft-certification-study-group-676990910176821270",
  },
  image: {
    domains: ["images.unsplash.com"],
  },
  prefetch: true,
  integrations: [
    partytown({
      config: {
        forward: ["dataLayer.push", "gtag"],
      },
    }),
    sitemap({
      i18n: {
        defaultLocale: "en", // All urls that don't contain language prefix will be treated as default locale
        locales: {
          en: "en", // The `defaultLocale` value must present in `locales` keys
        },
      },
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
              label: "Official Study Materials",
              link: "/guide/officialstudymaterials/",
            },
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
          label: "Discounted Exam Vouchers",
          items: [
            {
              label: "Virtual Training Days",
              link: "/vouchers/virtualtrainingdays/",
              badge: { text: "50%", variant: "note" },
            },
            {
              label: "Microsoft ESI",
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
              label: "Replay/Retake Vouchers",
              link: "/vouchers/mindhubreplayvoucherbundles/",
            },
          ],
        },
        {
          label: "Exam Study Materials Collection",
          link: "/wiki",
        },
        {
          label: "Exam Study Materials",
          collapsed: false,
          items: [
            {
              label: "Azure",
              collapsed: true,
              items: [
                { label: "AZ-104", link: "/azure/az-104/" },
                { label: "AZ-120", link: "/azure/az-120/" },
                { label: "AZ-140", link: "/azure/az-140/" },
                {
                  label: "AZ-204",
                  link: "/azure/az-204/",
                  badge: { text: "RETIRING", variant: "danger" },
                },
                { label: "AZ-305", link: "/azure/az-305/" },
                { label: "AZ-400", link: "/azure/az-400/" },
                {
                  label: "AZ-500",
                  link: "/azure/az-500/",
                  badge: { text: "RETIRING", variant: "danger" },
                },
                { label: "AZ-700", link: "/azure/az-700/" },
                {
                  label: "AZ-800",
                  link: "/azure/az-800/",
                },
                {
                  label: "AZ-801",
                  link: "/azure/az-801/",
                },
                { label: "AZ-900", link: "/azure/az-900/" },
                {
                  label: "DP-100",
                  link: "/azure/dp-100/",
                  badge: { text: "RETIRING", variant: "danger" },
                },
                { label: "DP-300", link: "/azure/dp-300/" },
                { label: "DP-420", link: "/azure/dp-420/" },
                { label: "DP-600", link: "/azure/dp-600/" },
                { label: "DP-700", link: "/azure/dp-700/" },
                {
                  label: "DP-750",
                  link: "/azure/dp-750/",
                  badge: { text: "BETA", variant: "tip" },
                },
                {
                  label: "DP-800",
                  link: "/azure/dp-800/",
                  badge: { text: "BETA", variant: "tip" },
                },
                { label: "DP-900", link: "/azure/dp-900/" },
              ],
            },
            {
              label: "GitHub",
              collapsed: true,
              items: [
                { label: "GH-100", link: "/github/gh-100/" },
                { label: "GH-200", link: "/github/gh-200/" },
                { label: "GH-300", link: "/github/gh-300/" },
                { label: "GH-500", link: "/github/gh-500/" },
                { label: "GH-900", link: "/github/gh-900/" },
              ],
            },
            {
              label: "AI & AB",
              collapsed: true,
              items: [
                { label: "AB-100", link: "/aiab/ab-100/" },
                { label: "AB-730", link: "/aiab/ab-730/" },
                { label: "AB-731", link: "/aiab/ab-731/" },
                { label: "AB-900", link: "/aiab/ab-900/" },
                {
                  label: "AI-102",
                  link: "/aiab/ai-102/",
                  badge: { text: "RETIRING", variant: "danger" },
                },
                {
                  label: "AI-300",
                  link: "/aiab/ai-300/",
                  badge: { text: "BETA", variant: "tip" },
                },
                {
                  label: "AI-900",
                  link: "/aiab/ai-900/",
                },
              ],
            },
            {
              label: "Microsoft 365",
              collapsed: true,
              items: [
                { label: "MD-102", link: "/microsoft365/md-102/" },
                { label: "MS-102", link: "/microsoft365/ms-102/" },
                { label: "MS-700", link: "/microsoft365/ms-700/" },
                { label: "MS-721", link: "/microsoft365/ms-721/" },
              ],
            },
            {
              label: "Security & Identity",
              collapsed: true,
              items: [
                { label: "SC-100", link: "/security/sc-100/" },
                { label: "SC-200", link: "/security/sc-200/" },
                { label: "SC-300", link: "/security/sc-300/" },
                { label: "SC-401", link: "/security/sc-401/" },
                { label: "SC-900", link: "/security/sc-900/" },
              ],
            },
            {
              label: "Power Platform",
              collapsed: true,
              items: [
                { label: "PL-200", link: "/power/pl-200/" },
                { label: "PL-300", link: "/power/pl-300/" },
                { label: "PL-400", link: "/power/pl-400/" },
                { label: "PL-500", link: "/power/pl-500/" },
                { label: "PL-600", link: "/power/pl-600/" },
                { label: "PL-900", link: "/power/pl-900/" },
              ],
            },
            {
              label: "Dynamics 365",
              collapsed: true,
              items: [
                { label: "MB-230", link: "/dynamics/mb-230/" },
                { label: "MB-240", link: "/dynamics/mb-240/" },
                { label: "MB-280", link: "/dynamics/mb-280/" },
                { label: "MB-310", link: "/dynamics/mb-310/" },
                { label: "MB-330", link: "/dynamics/mb-330/" },
              ],
            },
          ],
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
          href: "https://discord.gg/microsoft-certification-study-group-676990910176821270",
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
        light: "/src/images/logo_light.svg",
        dark: "/src/images/logo_dark.svg",
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
        {
          tag: "meta",
          attrs: { property: "og:image", content: site + "og.jpg" },
        },
        {
          tag: "meta",
          attrs: { property: "twitter:image", content: site + "og.jpg" },
        },
        {
          tag: "meta",
          attrs: { property: "og:url", content: "https://msfthub.com/" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:site_name",
            content: "Microsoft Certification Hub",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://msfthub.com" + "/og.jpg",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "twitter:image",
            content: "https://msfthub.com" + "/og.jpg",
          },
        },
      ],
    }),
    compressor({
      gzip: false,
      brotli: true,
    }),
    mdx(),
  ],
  experimental: {
    clientPrerender: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});

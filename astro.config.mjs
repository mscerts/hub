import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import compressor from "astro-compressor";
import starlight from "@astrojs/starlight";
import starlightImageZoom from 'starlight-image-zoom'
import partytown from '@astrojs/partytown'
import starlightCoolerCredit from 'starlight-cooler-credit'
import { viewTransitions } from "astro-vtbot/starlight-view-transitions";
import starlightBlog from 'starlight-blog';
import starlightVideos from 'starlight-videos'
import mdx from "@astrojs/mdx";

const googleAnalyticsId = 'G-CDTP3TERKP'
const clarityAnalyticsId = 'u7pei4s9cq'
const googleTagManagerId = 'GTM-TMNHVD5B'
const site = 'https://msfthub.com/';

// https://astro.build/config
export default defineConfig({
  // https://docs.astro.build/en/guides/images/#authorizing-remote-images
  site: "https://msfthub.com",
  redirects: {
        '/guide': '/guide/introduction',
        '/microsoft365': '/wiki',
        '/azure': '/wiki',
        '/powerplatform': '/wiki',
        '/security': '/wiki',
        '/dynamics': '/wiki',
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
          en: "en" // The `defaultLocale` value must present in `locales` keys
        },
      },
    }),
    starlight({
      title: "Microsoft Certification Hub",
    plugins: [
       starlightCoolerCredit({
          showImage: true,
          customImage: "./src/assets/images/mascot.png",
          customImageAlt: "MSFTHub Mascot",
          credit: {
              title: {
                  en: "Have more questions?",
              },
              href: "https://discord.com/invite/microsoft-certification-study-group-676990910176821270",
              description: {
                  en: "Join our Discord server and ask away!",
              },
          },
      }), 
      viewTransitions(),
      starlightVideos(),
      starlightImageZoom(),
      starlightBlog({
        authors: {
          nighthouse: {
            name: 'nighthouse',
            title: 'Content & Site Editor',
            picture: 'https://avatars.githubusercontent.com/u/121154936?v=4',
            url: 'https://github.com/n1ghthouse',
          },
          teriaavibes: {
            name: 'teriaavibes',
            title: 'Content Editor',
            picture: 'https://avatars.githubusercontent.com/u/68708075?v=4', 
            url: 'https://github.com/teriaavibes',
          },
        },
      }), 
    ], 
    sidebar: [
        {
            label: 'Certification Program Guide',
            items: [
                { label: 'Introduction', link: '/guide/introduction/' },
                { label: 'Overview', link: '/guide/overview/' },
                { label: 'Scheduling an Exam', link: '/guide/schedulingexam/' },						
                { label: 'Certification Dashboard', link: '/guide/certificationdashboard/' },
                { label: 'Exam Experience', link: '/guide/takingtheexams/' },
                { label: 'Official Study Materials', link: '/guide/officialstudymaterials/' },
                { label: 'Opportunities for Students', link: '/guide/studentopportunities/' },
                { label: 'Certification Renewal', link: '/guide/certificationrenewal/' },
                { label: 'Microsoft Partner Employees', link: '/guide/partneremployees/' },

            ],
        },
        {
            label: 'Discounted Exam Vouchers',
            items: [
	              { label: 'Get Fabric Certified', link: '/vouchers/getfabriccertified/' ,badge: { text: '100%', variant: 'tip' }, },
				        { label: 'AI Challenge', link: '/vouchers/aichallenge/' ,badge: { text: '50%', variant: 'tip' }, },
                { label: 'Virtual Training Days', link: '/vouchers/virtualtrainingdays/' ,badge: { text: '50%', variant: 'note' }, },
                { label: 'Microsoft ESI', link: '/vouchers/microsoftesi/' ,badge: { text: '*50%', variant: 'note' }, },
                { label: 'Microsoft x Coursera', link: '/vouchers/microsoftxcoursera/' ,badge: { text: '*50%', variant: 'note' }, },		
                { label: 'Microsoft x Datacamp', link: '/vouchers/microsoftxdatacamp/' ,badge: { text: '*50%', variant: 'note' }, },			
                { label: 'Beta Exams', link: '/vouchers/betaexams/' ,badge: { text: '*80% + 25%', variant: 'note' }, },
		            { label: 'Replay/Retake Vouchers', link: '/vouchers/mindhubreplayvoucherbundles/' },

            ],
        },
        {
            label: 'Exam Study Materials Collection',
            link: '/wiki',
        },
        {
            label: 'Exam Study Materials',
            collapsed: false,
            items: [
                { label: 'Azure', collapsed:true, autogenerate: { directory: 'azure', collaped:true },},
                { label: 'GitHub', collapsed:true, autogenerate: { directory: 'github', collaped:true },},
                { label: 'AI & AB', collapsed:true, autogenerate: { directory: 'ai&ab', collaped:true },},
                { label: 'Microsoft 365', collapsed:true, autogenerate: { directory: 'microsoft365', collaped:true },},
                { label: 'Security & Identity', collapsed:true, autogenerate: { directory: 'security', collaped:true },},
                { label: 'Power Platform', collapsed:true, autogenerate: { directory: 'power', collaped:true },},
                { label: 'Dynamics 365', collapsed:true, autogenerate: { directory: 'dynamics', collaped:true },},

            ],
        },
        {
            label: 'Contributing',
            link: '/contributing',
        },
        {
            label: 'Privacy Policy',
            link: '/privacy',
        },
    ],
      social: [
           { icon: 'github', label: 'GitHub', href: 'https://github.com/mscerts/hub', },
           { icon: 'discord', label: 'Discord', href: 'https://discord.gg/microsoft-certification-study-group-676990910176821270', },
      ],
      disable404Route: true,
      editLink: {
        baseUrl: 'https://github.com/mscerts/hub/edit/main/',
      },
      customCss: process.env.NO_GRADIENTS ? [	'./src/custom.css'] : ['./src/landing.css', './src/custom.css', "./src/assets/styles/starlight.css"],
      logo: {
        light: '/src/images/logo_light.svg',
        dark: '/src/images/logo_dark.svg',
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      components: {
        SiteTitle: "./src/components/ui/starlight/SiteTitle.astro",
        Head: "./src/components/ui/starlight/Head.astro",
        MobileMenuFooter: "./src/components/ui/starlight/MobileMenuFooter.astro",
        /* ThemeSelect: "./src/components/ui/starlight/ThemeSelect.astro", */
        MarkdownContent: "./src/components/MarkdownContent.astro", 
        /* Sidebar: './src/components/Sidebar.astro', */
      },
      head: [
        {
            tag: 'script',
            attrs: {
              src: `https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsId}`,
            },
        },
        {
            tag: 'script',
            attrs: {
              src: `https://www.clarity.ms/tag/${clarityAnalyticsId}`,
            },
        },
        {
            tag: 'script',
            content: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
  
            gtag('config', '${googleAnalyticsId}');
            `,
        },
        {
            tag: 'script',
            content: `    
             (function(c,l,a,r,i,t,y){
             c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
             t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
             y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
             })(window, document, "clarity", "script", "${clarityAnalyticsId}")
            `,
        },
        {
            tag: 'script',
            content: `
             (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
             new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
             j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
             'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
             })(window,document,'script','dataLayer','${googleTagManagerId}');
            `,
        },
        {
            tag: 'meta',
            attrs: { property: 'og:image', content: site + 'og.jpg' },
        },
        {
            tag: 'meta',
            attrs: { property: 'twitter:image', content: site + 'og.jpg' },
        },
        {
            tag: 'meta',
            attrs: { property: 'og:url', content: 'https://msfthub.com/' },
        },
        {
            tag: 'meta',
            attrs: { property: 'og:site_name', content: 'Microsoft Certification Hub' },
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

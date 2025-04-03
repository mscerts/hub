import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightImageZoom from 'starlight-image-zoom'
import partytown from '@astrojs/partytown'
import starlightCoolerCredit from 'starlight-cooler-credit'
import { viewTransitions } from "astro-vtbot/starlight-view-transitions";
import starlightBlog from 'starlight-blog';
import starWarp from '@inox-tools/star-warp';

const googleAnalyticsId = 'G-CDTP3TERKP'
const site = 'https://certs.msfthub.wiki/';

export default defineConfig({
    site: 'https://certs.msfthub.wiki/',
    redirects: {
        '/office': '/wiki',
        '/guide': '/guide/introduction',
        '/m365': '/wiki',
        '/microsoft365': '/wiki',
        '/azure': '/wiki',
        '/power': '/wiki',
        '/powerplatform': '/wiki',
        '/security': '/wiki',
        '/dynamics': '/wiki',
        '/dynamics365': '/wiki',
      },
    integrations:[partytown({
        config: {
          forward: ["dataLayer.push", "gtag"],
        },
    }), starlight({
    plugins: [
/*          starlightCoolerCredit({
          showImage: true,
          customImage: "./src/assets/mascot.png",
          customImageAlt: "MSFT Cert Mascot",
          credit: {
              title: {
                  en: "Have any exam feedback?",
              },
              href: "https://discord.gg/y7jXDE6NVf",
              description: {
                  en: "Join our Discord server and share your feedback with us!",
              },
          },
      }), */
      viewTransitions(),
      starlightImageZoom(),
      starWarp(),
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
    components: {
        MarkdownContent: "./src/components/MarkdownContent.astro",
    }, 
    title: 'Microsoft Certification Hub',
    head: [
        {
            tag: 'script',
            attrs: {
              src: `https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsId}`,
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
            tag: 'meta',
            attrs: { property: 'og:image', content: site + 'og.jpg' },
        },
        {
            tag: 'meta',
            attrs: { property: 'twitter:image', content: site + 'og.jpg' },
        },
        {
            tag: 'meta',
            attrs: { property: 'og:url', content: 'https://certs.msfthub.wiki/' },
        },
    ],
    editLink: {
        baseUrl: 'https://github.com/mscerts/hub/edit/main/',
    },
    logo: {
        light: '/src/assets/msftcertblack.svg',
        dark: '/src/assets/msftcertwhite.svg',
        replacesTitle: true,
    },
    customCss: process.env.NO_GRADIENTS ? [	'./src/custom.css'] : ['./src/landing.css', 	'./src/custom.css'],
    social: {
        github: 'https://github.com/mscerts/hub',
        discord: 'https://discord.gg/microsoft-certification-study-group-676990910176821270',
    },
    sidebar: [
        {
            label: 'Updates Blog',
            link: '/blog',
        },
        {
            label: 'Certification Program Guide',
            items: [
                { label: 'Introduction', link: '/guide/introduction/' },
                { label: 'Overview', link: '/guide/overview/' },
                { label: 'Scheduling an Exam', link: '/guide/schedulingexam/' },						
                { label: 'Certification Dashboard', link: '/guide/certificationdashboard/' },
                { label: 'Taking The Exam', link: '/guide/takingtheexams/' },
                { label: 'Official Study Materials', link: '/guide/officialstudymaterials/' },
                { label: 'Opportunities for Students', link: '/guide/studentopportunities/' },
                { label: 'Certification Renewal', link: '/guide/certificationrenewal/' },
                { label: 'Microsoft Partner Employees', link: '/guide/partneremployees/' },

            ],
        },
        {
            label: 'Exam Voucher Collection',
            link: '/vouchers',
        },
        {
            label: 'Discounted Exam Vouchers',
            items: [
		    { label: 'DP-700 Discount', link: '/vouchers/dp-700discount/' ,badge: { text: '50%', variant: 'note' }, },
		    { label: 'DP-600 for Partners', link: '/vouchers/dp-600forpartners/' ,badge: { text: '100%', variant: 'note' }, },
                { label: 'Virtual Training Days', link: '/vouchers/virtualtrainingdays/' ,badge: { text: '50%', variant: 'note' }, },
                { label: 'Microsoft ESI', link: '/vouchers/microsoftesi/' ,badge: { text: '50%', variant: 'note' }, },
                { label: 'Power Up Program', link: '/vouchers/powerupprogram/' ,badge: { text: '100%', variant: 'note' }, },						
                { label: 'Beta Exams', link: '/vouchers/betaexams/' ,badge: { text: '80% + 25%', variant: 'note' }, },
		    { label: 'Replay/Retake Vouchers', link: '/vouchers/mindhubreplayvoucherbundles/' },

            ],
        },
        {
            label: 'Exam Wiki Collection',
            link: '/wiki',
        },
        {
            label: 'Exam Study Materials',
            collapsed: false,
            items: [
                { label: 'Azure', collapsed:true, autogenerate: { directory: 'azure', collaped:true },},
                { label: 'Microsoft 365', collapsed:true, autogenerate: { directory: 'microsoft365', collaped:true },},
                { label: 'Security & Identity', collapsed:true, autogenerate: { directory: 'security', collaped:true },},
                { label: 'Power Platform', collapsed:true, autogenerate: { directory: 'power', collaped:true },},
                { label: 'Dynamics 365', collapsed:true, autogenerate: { directory: 'dynamics', collaped:true },},
                { label: 'Office Apps', collapsed:true, autogenerate: { directory: 'office', collaped:true },},

            ],
        },
        {
            label: 'Contributing',
            link: '/contributing',
        },
    ],
    lastUpdated: true,
		}),
    ],
});
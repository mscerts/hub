import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightImageZoom from 'starlight-image-zoom'
import partytown from '@astrojs/partytown'
import starlightCoolerCredit from 'starlight-cooler-credit'
import { viewTransitions } from "astro-vtbot/starlight-view-transitions";
import starlightBlog from 'starlight-blog';
import starlightVideos from 'starlight-videos'

const googleAnalyticsId = 'G-CDTP3TERKP'
const clarityAnalyticsId = 'ke9gk0s2sg'
const site = 'https://certs.msfthub.wiki/';

export default defineConfig({
    site: 'https://certs.msfthub.wiki/',
    redirects: {
        '/office/mo-110/': '/office',
        '/office/mo-111/': '/office',
        '/office/mo-210/': '/office',
        '/office/mo-211/': '/office',
        '/office/mo-310/': '/office',
        '/guide': '/guide/introduction',
        '/m365': '/wiki',
        '/microsoft365': '/wiki',
        '/azure': '/wiki',
        '/power': '/wiki',
        '/powerplatform': '/wiki',
        '/security': '/wiki',
        '/dynamics': '/wiki',
        '/dynamics365': '/wiki',
        '/az-107': '/azure/az-104/',
      },
    integrations:[partytown({
        config: {
          forward: ["dataLayer.push", "gtag"],
        },
    }), starlight({
    plugins: [
       starlightCoolerCredit({
          showImage: true,
          customImage: "./src/assets/mascot.png",
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
    components: {
        MarkdownContent: "./src/components/MarkdownContent.astro", 
        /* Sidebar: './src/components/Sidebar.astro', */
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
        {
            tag: 'meta',
            attrs: { property: 'og:site_name', content: 'Microsoft Certification Hub' },
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
    customCss: process.env.NO_GRADIENTS ? [	'./src/custom.css'] : ['./src/landing.css', './src/custom.css'],
    social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/mscerts/hub', },
        { icon: 'discord', label: 'Discord', href: 'https://discord.gg/microsoft-certification-study-group-676990910176821270', },
    ],
    sidebar: [
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
            	{ label: 'Partner Certification Week', link: '/vouchers/partnercertweek/' ,badge: { text: '*100%', variant: 'tip' }, },
				{ label: 'Microsoft Partner LevelUp', link: '/vouchers/levelup/' ,badge: { text: '*100%', variant: 'tip' }, },
                { label: 'FabCon Vienna Offer', link: '/vouchers/fabricviennaoffer/' ,badge: { text: '50%', variant: 'tip' }, },
                { label: 'Virtual Training Days', link: '/vouchers/virtualtrainingdays/' ,badge: { text: '50%', variant: 'note' }, },
                { label: 'Microsoft x Coursera', link: '/vouchers/microsoftxcoursera/' ,badge: { text: '50%', variant: 'note' }, },
                { label: 'Microsoft ESI', link: '/vouchers/microsoftesi/' ,badge: { text: '*50%', variant: 'note' }, },
                { label: 'Power Up Program', link: '/vouchers/powerupprogram/' ,badge: { text: '*100%', variant: 'note' }, },						
                { label: 'Beta Exams', link: '/vouchers/betaexams/' ,badge: { text: '*80% + 25%', variant: 'note' }, },
		        { label: 'Replay/Retake Vouchers', link: '/vouchers/mindhubreplayvoucherbundles/' },

            ],
        },
        {
            label: 'Exam Study Materials Collection',
            link: '/wiki',
        },
        {
            label: 'Exam Study Labs Collection',
            link: '/labs',
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
    lastUpdated: true,
		}),
    ],
});

import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightImageZoom from 'starlight-image-zoom'
import partytown from '@astrojs/partytown'
import starlightCoolerCredit from 'starlight-cooler-credit'
import { viewTransitions } from "astro-vtbot/starlight-view-transitions";
import starlightBlog from 'starlight-blog';
import starlightVideos from 'starlight-videos'
import Icons from 'starlight-plugin-icons'

const googleAnalyticsId = 'G-CDTP3TERKP'
const clarityAnalyticsId = 'ke9gk0s2sg'
const site = 'https://certs.msfthub.wiki/';

export default defineConfig({
    site: 'https://certs.msfthub.wiki/',
    redirects: {
        '/guide': 'https://msfthub.com/guide/introduction',
        '/m365': 'https://msfthub.com/wiki',
        '/microsoft365': 'https://msfthub.com/wiki',
        '/azure': 'https://msfthub.com/wiki',
        '/power': 'https://msfthub.com/wiki',
        '/powerplatform': 'https://msfthub.com/wiki',
        '/security': 'https://msfthub.com/wiki',
        '/dynamics': 'https://msfthub.com/wiki',
        '/dynamics365': 'https://msfthub.com/wiki',
        '/guide/introduction/': 'https://msfthub.com/guide/introduction',
        '/guide/overview/': 'https://msfthub.com/guide/overview',
        '/guide/schedulingexam/': 'https://msfthub.com/guide/schedulingexam',
        '/guide/certificationdashboard/': 'https://msfthub.com/guide/certificationdashboard',
        '/guide/takingtheexams/': 'https://msfthub.com/guide/takingtheexams',
        '/guide/officialstudymaterials/': 'https://msfthub.com/guide/officialstudymaterials',
        '/guide/studentopportunities/': 'https://msfthub.com/guide/studentopportunities',
        '/guide/certificationrenewal/': 'https://msfthub.com/guide/certificationrenewal',
        '/guide/partneremployees/': 'https://msfthub.com/guide/partneremployees',
        '/vouchers/': 'https://msfthub.com/vouchers',
        '/labs/': 'https://msfthub.com/labs',
        '/wiki/': 'https://msfthub.com/wiki',
        '/contributing': 'https://msfthub.com/contributing',
        '/privacy': 'https://msfthub.com/privacy',
        '/vouchers/getfabriccertified/': 'https://msfthub.com/vouchers/getfabriccertified',
        '/vouchers/aichallenge/': 'https://msfthub.com/vouchers/aichallenge',
        '/vouchers/virtualtrainingdays/': 'https://msfthub.com/vouchers/virtualtrainingdays',
        '/vouchers/microsoftesi/': 'https://msfthub.com/vouchers/microsoftesi',
        '/vouchers/microsoftxcoursera/': 'https://msfthub.com/vouchers/microsoftxcoursera',
        '/vouchers/microsoftxdatacamp/': 'https://msfthub.com/vouchers/microsoftxdatacamp',
        '/vouchers/betaexams/': 'https://msfthub.com/vouchers/betaexams',
        '/vouchers/mindhubreplayvoucherbundles/': 'https://msfthub.com/vouchers/mindhubreplayvoucherbundles',
        '/azure/ai-102/': 'https://msfthub.com/wiki/ai-102',
        '/azure/ai-900/': 'https://msfthub.com/wiki/ai-900',
        '/azure/az-104/': 'https://msfthub.com/wiki/az-104',
        '/azure/az-120/': 'https://msfthub.com/wiki/az-120',
        '/azure/az-140/': 'https://msfthub.com/wiki/az-140',
        '/azure/az-204/': 'https://msfthub.com/wiki/az-204',
        '/azure/az-305/': 'https://msfthub.com/wiki/az-305',
        '/azure/az-400/': 'https://msfthub.com/wiki/az-400',
        '/azure/az-500/': 'https://msfthub.com/wiki/az-500',
        '/azure/az-700/': 'https://msfthub.com/wiki/az-700',
        '/azure/az-800/': 'https://msfthub.com/wiki/az-800',
        '/azure/az-801/': 'https://msfthub.com/wiki/az-801',
        '/azure/az-900/': 'https://msfthub.com/wiki/az-900',
        '/azure/dp-100/': 'https://msfthub.com/wiki/dp-100',
        '/azure/dp-300/': 'https://msfthub.com/wiki/dp-300',
        '/azure/dp-420/': 'https://msfthub.com/wiki/dp-420',
        '/azure/dp-600/': 'https://msfthub.com/wiki/dp-600',
        '/azure/dp-700/': 'https://msfthub.com/wiki/dp-700',
        '/azure/dp-900/': 'https://msfthub.com/wiki/dp-900',
        '/github/gh-100/': 'https://msfthub.com/wiki/gh-100',
        '/github/gh-200/': 'https://msfthub.com/wiki/gh-200',
        '/github/gh-300/': 'https://msfthub.com/wiki/gh-300',
        '/github/gh-500/': 'https://msfthub.com/wiki/gh-500',
        '/github/gh-900/': 'https://msfthub.com/wiki/gh-900',
        '/microsoft365/md-102/': 'https://msfthub.com/wiki/md-102',
        '/microsoft365/ms-102/': 'https://msfthub.com/wiki/ms-102',
        '/microsoft365/ms-700/': 'https://msfthub.com/wiki/ms-700',
        '/microsoft365/ms-721/': 'https://msfthub.com/wiki/ms-721',
        '/microsoft365/ms-900/': 'https://msfthub.com/wiki/ms-900',
        '/security/sc-100/': 'https://msfthub.com/wiki/sc-100',
        '/security/sc-200/': 'https://msfthub.com/wiki/sc-200',
        '/security/sc-300/': 'https://msfthub.com/wiki/sc-300',
        '/security/sc-401/': 'https://msfthub.com/wiki/sc-401',
        '/security/sc-900/': 'https://msfthub.com/wiki/sc-900',
        '/power/pl-200/': 'https://msfthub.com/wiki/pl-200',
        '/power/pl-300/': 'https://msfthub.com/wiki/pl-300',
        '/power/pl-400/': 'https://msfthub.com/wiki/pl-400',
        '/power/pl-500/': 'https://msfthub.com/wiki/pl-500',
        '/power/pl-600/': 'https://msfthub.com/wiki/pl-600',
        '/power/pl-900/': 'https://msfthub.com/wiki/pl-900',
        '/dynamics/mb-230/': 'https://msfthub.com/wiki/mb-230',
        '/dynamics/mb-240/': 'https://msfthub.com/wiki/mb-240',
        '/dynamics/mb-280/': 'https://msfthub.com/wiki/mb-280',
        '/dynamics/mb-310/': 'https://msfthub.com/wiki/mb-310',
        '/dynamics/mb-330/': 'https://msfthub.com/wiki/mb-330',

        '/labs/azure/ai-102/': 'https://msfthub.com/labs/azure/ai-102',
        '/labs/azure/ai-900/': 'https://msfthub.com/labs/azure/ai-900',
        '/labs/azure/az-104/': 'https://msfthub.com/labs/azure/az-104',
        '/labs/azure/az-120/': 'https://msfthub.com/labs/azure/az-120',
        '/labs/azure/az-140/': 'https://msfthub.com/labs/azure/az-140',
        '/labs/azure/az-204/': 'https://msfthub.com/labs/azure/az-204',
        '/labs/azure/az-305/': 'https://msfthub.com/labs/azure/az-305',
        '/labs/azure/az-400/': 'https://msfthub.com/labs/azure/az-400',
        '/labs/azure/az-500/': 'https://msfthub.com/labs/azure/az-500',
        '/labs/azure/az-700/': 'https://msfthub.com/labs/azure/az-700',
        '/labs/azure/az-800/': 'https://msfthub.com/labs/azure/az-800',
        '/labs/azure/az-801/': 'https://msfthub.com/labs/azure/az-801',
        '/labs/azure/az-900/': 'https://msfthub.com/labs/azure/az-900',
        '/labs/azure/dp-100/': 'https://msfthub.com/labs/azure/dp-100',
        '/labs/azure/dp-300/': 'https://msfthub.com/labs/azure/dp-300',
        '/labs/azure/dp-420/': 'https://msfthub.com/labs/azure/dp-420',
        '/labs/azure/dp-600/': 'https://msfthub.com/labs/azure/dp-600',
        '/labs/azure/dp-700/': 'https://msfthub.com/labs/azure/dp-700',
        '/labs/azure/dp-900/': 'https://msfthub.com/labs/azure/dp-900',
        '/labs/microsoft365/md-102/': 'https://msfthub.com/labs/microsoft365/md-102',
        '/labs/microsoft365/ms-102/': 'https://msfthub.com/labs/microsoft365/ms-102',
        '/labs/microsoft365/ms-700/': 'https://msfthub.com/labs/microsoft365/ms-700',
        '/labs/microsoft365/ms-721/': 'https://msfthub.com/labs/microsoft365/ms-721',
        '/labs/microsoft365/ms-900/': 'https://msfthub.com/labs/microsoft365/ms-900',
        '/labs/security/sc-100/': 'https://msfthub.com/labs/security/sc-100',
        '/labs/security/sc-200/': 'https://msfthub.com/labs/security/sc-200',
        '/labs/security/sc-300/': 'https://msfthub.com/labs/security/sc-300',
        '/labs/security/sc-401/': 'https://msfthub.com/labs/security/sc-401',
        '/labs/security/sc-900/': 'https://msfthub.com/labs/security/sc-900',
        '/labs/power/pl-200/': 'https://msfthub.com/labs/power/pl-200',
        '/labs/power/pl-300/': 'https://msfthub.com/labs/power/pl-300',
        '/labs/power/pl-400/': 'https://msfthub.com/labs/power/pl-400',
        '/labs/power/pl-500/': 'https://msfthub.com/labs/power/pl-500',
        '/labs/power/pl-600/': 'https://msfthub.com/labs/power/pl-600',
        '/labs/power/pl-900/': 'https://msfthub.com/labs/power/pl-900',
        '/labs/dynamics/mb-230/': 'https://msfthub.com/labs/dynamics/mb-230',
        '/labs/dynamics/mb-240/': 'https://msfthub.com/labs/dynamics/mb-240',
        '/labs/dynamics/mb-280/': 'https://msfthub.com/labs/dynamics/mb-280',
        '/labs/dynamics/mb-310/': 'https://msfthub.com/labs/dynamics/mb-310',
        '/labs/dynamics/mb-330/': 'https://msfthub.com/labs/dynamics/mb-330',
        '/blog/': 'https://msfthub.com/blog',
        '/blog/githubexamsandignite/': 'https://msfthub.com/blog/githubexamsandignite',
        '/blog/newupdate/': 'https://msfthub.com/blog/newupdate',
        '/blog/rss.xml': 'https://msfthub.com/blog/rss.xml',
        '/': 'https://msfthub.com/',
      },
    integrations:[partytown({
        config: {
          forward: ["dataLayer.push", "gtag"],
        },
    }), 

    Icons({
    sidebar: true,
    extractSafelist: true,
    starlight: {
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
                { label: 'Exam Experience', link: '/guide/takingtheexams/' },
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
            label: 'Exam Study Labs Collection',
            link: '/labs',
        },
        {
            label: 'Exam Study Materials',
            collapsed: false,
            items: [
                { label: 'Azure', collapsed:true, autogenerate: { directory: 'azure', collaped:true },},
                { label: 'GitHub', collapsed:true, autogenerate: { directory: 'github', collaped:true },},
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
		},
    }),
    ],
});

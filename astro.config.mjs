import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog'
import starlightImageZoom from 'starlight-image-zoom'
import partytown from '@astrojs/partytown'

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
    integrations:[
        partytown({
            config: {
              forward: ["dataLayer.push", "gtag"],
            },
        }),
		starlight({
        plugins: [
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
        },
        title: 'Microsoft Certification Hub',
        head: [
            {
                tag: 'script',
                attrs: {
                    src: 'https://www.clarity.ms/ke9gk0s2sg/', 'clarity': 'ke9gk0s2sg', 
                    defer: true,
                },
            },
            {
                tag: 'script',
                type: 'text/javascript',
                children: `
                    (function(c,l,a,r,i,t,y){
                    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
                    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
                    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
                    })(window, document, "clarity", "script", "ke9gk0s2sg");
                `,
            },
            {
                tag: 'script',
                type: 'text/partytown',
                children: `
                    (function(c,l,a,r,i,t,y){
                    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
                    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
                    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
                    })(window, document, "clarity", "script", "ke9gk0s2sg");
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
                label: 'Guide',
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
                label: 'Voucher Offers',
                items: [
                    { label: 'Beta Exams', link: '/vouchers/betaexams/' },
                    { label: 'Cloud Skills Challenges', link: '/vouchers/cloudskillschallenges/',badge: { text: 'N/A', variant: 'danger' }, },
                    { label: 'Microsoft ESI', link: '/vouchers/microsoftesi/' },
                    { label: 'Mindhub Replay Voucher Bundles', link: '/vouchers/mindhubreplayvoucherbundles/' },						
                    { label: 'Power Up Program', link: '/vouchers/powerupprogram/' },
                    { label: 'Virtual Training Days', link: '/vouchers/virtualtrainingdays/' },
                ],
            },
            {
                label: 'Wiki Collection',
                link: '/wiki',
            },
            {
                label: 'Exams',
                collapsed: false,
                items: [
                    { label: 'Azure', collapsed:true, autogenerate: { directory: 'azure', collaped:true },},
                    { label: 'Microsoft 365', collapsed:true, autogenerate: { directory: 'microsoft365', collaped:true },},
                    { label: 'Security & Identity', collapsed:true, autogenerate: { directory: 'security', collaped:true },},
                    { label: 'Power Platform', collapsed:true, autogenerate: { directory: 'power', collaped:true },},
                    { label: 'Dynamics 365', collapsed:true, autogenerate: { directory: 'dynamics', collaped:true },},
                    { label: 'Office', collapsed:true, autogenerate: { directory: 'office', collaped:true },},

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
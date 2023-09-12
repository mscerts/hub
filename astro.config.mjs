import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'MCH',
      logo: {
				light: '/src/assets/images/msftcertblack.svg',
				dark: '/src/assets/images/msftcertwhite.svg',
				replacesTitle: true,
      },
      social: {
        github: 'https://github.com/mscerts/hub',
        discord: 'https://discord.gg/microsoft-certification-study-group-676990910176821270',
      },
      sidebar: [
        {
          label: 'Guide',
          autogenerate: { directory: 'guide' },
        },
        {
          label: 'Voucher Offers',
          autogenerate: { directory: 'vouchers' },
        },
        {
          label: 'Wiki',
          collapsed: false,
          items: [
            { label: 'Azure', collapsed:true, autogenerate: { directory: 'Azure', collaped:true },},
            { label: 'Dynamics 365', collapsed:true, autogenerate: { directory: 'Dynamics 365', collaped:true },},
            { label: 'Microsoft 365', collapsed:true, autogenerate: { directory: 'Microsoft 365', collaped:true },},
            { label: 'Power Platform', collapsed:true, autogenerate: { directory: 'Power Platform', collaped:true },},
            { label: 'Security, Compliance & Identity', collapsed:true, autogenerate: { directory: 'Security, Compliance, and Identity', collaped:true },},
          ]
        },
      ],
    }),
  ],

  // Process images with sharp: https://docs.astro.build/en/guides/assets/#using-sharp
  image: { service: { entrypoint: 'astro/assets/services/sharp' } },
});

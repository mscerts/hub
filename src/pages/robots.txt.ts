// https://docs.astro.build/en/guides/integrations-guide/sitemap/#usage
import type { APIRoute } from 'astro';

const robotsTxt = `
User-agent: Googlebot
Disallow: /*.md$
Allow: /
Crawl-delay: 10

User-agent: Yandex
Disallow: /*.md$
Allow: /
Crawl-delay: 2

User-agent: Bingbot
Disallow: /*.md$
Allow: /
Crawl-delay: 2

User-agent: bingbot
Disallow: /*.md$
Allow: /
Crawl-delay: 2

User-agent: archive.org_bot
Disallow: /*.md$
Allow: /
Crawl-delay: 2

User-agent: *
Disallow: /*.md$
Allow: /

Sitemap: ${new URL('sitemap-index.xml', import.meta.env.SITE).href}
`.trim();

export const GET: APIRoute = () => {
  return new Response(robotsTxt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
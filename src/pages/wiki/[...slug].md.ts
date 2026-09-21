import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export async function getStaticPaths() {
  const docs = await getCollection("docs");
  const isDev = import.meta.env.DEV;

  return docs
    .filter((entry) => entry.id !== "wiki" && (isDev || entry.data.draft !== true))
    .map((entry) => ({
      params: { slug: entry.id.toLowerCase() },
    }));
}

export const GET: APIRoute = ({ params }) =>
  new Response(null, {
    status: 301,
    headers: { Location: `/certs/${params.slug}/` },
  });

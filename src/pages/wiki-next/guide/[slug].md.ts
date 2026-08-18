import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { serializeEntry } from "@utils/markdown/serializeMdx";

export async function getStaticPaths() {
  const docs = await getCollection("docs");
  const isDev = import.meta.env.DEV;

  return docs
    .filter((entry) => entry.id.startsWith("guide/") && (isDev || entry.data.draft !== true))
    .map((entry) => ({
      params: { slug: entry.id.replace(/^guide\//, "") },
      props: { entry },
    }));
}

export const GET: APIRoute = async ({ props }) => {
  const entry = props.entry as { body?: string; data: { title?: string; description?: string } };

  return new Response(await serializeEntry(entry), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};

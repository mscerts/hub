import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { serializeEntry } from "@utils/markdown/serializeMdx";

export async function getStaticPaths() {
  const docs = await getCollection("docs");
  const isDev = import.meta.env.DEV;

  return docs
    .filter((entry) => entry.id !== "wiki" && (isDev || entry.data.draft !== true))
    .map((entry) => ({
      params: { slug: entry.id.toLowerCase() },
      props: { entry },
    }));
}

export const GET: APIRoute = async ({ props }) => {
  return new Response(await serializeEntry(props.entry), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};

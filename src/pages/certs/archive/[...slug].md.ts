import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { serializeEntry } from "@utils/markdown/serializeMdx";

export async function getStaticPaths() {
  return (await getCollection("archive", ({ data }) => !data.draft)).map(
    (entry) => ({
      params: { slug: entry.id.toLowerCase() },
      props: { entry },
    }),
  );
}

export const GET: APIRoute = async ({ props }) =>
  new Response(
    `> Archived content: retained for historical reference and may be outdated.\n\n${await serializeEntry(props.entry)}`,
    {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );

// https://docs.astro.build/en/guides/content-collections/#defining-collections

import { z, defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { docsLoader } from "@astrojs/starlight/loaders";

// Author schema for blog posts (supports local images or remote URLs)
const authorSchema = (image: any) =>
  z.object({
    name: z.string(),
    image: z.union([image(), z.string().url()]),
    imageAlt: z.string().optional(),
  });

const blogCollection = defineCollection({
  loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/blog" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      authors: z.array(authorSchema(image)),
      pubDate: z.date(),
      updatedDate: z.date().optional(),
      cardImage: image(),
      cardImageAlt: z.string().optional(),
      readTime: z.number(),
      tags: z.array(z.string()).optional(),
      draft: z.boolean().optional(),
    }),
});

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema(),
  }),
  blog: blogCollection,
};

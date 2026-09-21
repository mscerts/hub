// https://docs.astro.build/en/guides/content-collections/#defining-collections

import { defineCollection, type ImageFunction } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";

// Author schema for blog posts (supports local images or remote URLs)
const authorSchema = (image: ImageFunction) =>
  z.object({
    name: z.string(),
    image: z.union([image(), z.url()]),
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
    loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/docs" }),
    schema: z.strictObject({
      title: z.string(),
      description: z.string().optional(),
      draft: z.boolean().optional(),
      voucherCategory: z.enum(["100%", "50%", "Special"]).optional(),
      editUrl: z.union([z.string(), z.boolean()]).optional(),
      lastUpdated: z.union([z.date(), z.boolean()]).optional(),
      next: z.union([z.string(), z.boolean()]).optional(),
      prev: z.union([z.string(), z.boolean()]).optional(),
      tableOfContents: z.boolean().optional(),
      template: z.enum(["doc", "splash"]).optional(),
      hero: z
        .strictObject({
          title: z.string().min(1),
          tagline: z.string().optional(),
          image: z.strictObject({ file: z.string().min(1) }).optional(),
          actions: z
            .array(
              z.strictObject({
                text: z.string().min(1),
                link: z.string().min(1),
                icon: z.string().optional(),
                variant: z.enum(["primary", "secondary", "minimal"]).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  }),
  blog: blogCollection,
};

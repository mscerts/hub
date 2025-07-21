import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { docsLoader } from "@astrojs/starlight/loaders";
import { blogSchema } from 'starlight-blog/schema';
import { videosSchema } from 'starlight-videos/schemas'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: (context) => videosSchema.merge(blogSchema(context)) }),
  }),
};

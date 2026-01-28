import { defineCollection, z } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { docsLoader } from "@astrojs/starlight/loaders";
import { blogSchema } from 'starlight-blog/schema';
import { videosSchema } from 'starlight-videos/schemas'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ 
      extend: (context) => videosSchema.merge(blogSchema(context)).merge(
        z.object({
          // Add a default value to the built-in `banner` field.
          banner: z.object({ content: z.string() }).default({
            content: `<a href="https://msfthub.com" target="_blank">
  We are migrating to a new domain! Click here to visit MSFTHub.com.
</a>`,
          }),
        })
      )
    }),
  }),
};

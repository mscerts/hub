import { defineCollection } from 'astro:content';
import { docsAndBlogSchema } from 'starlight-blog/schema';

export const collections = {
    docs: defineCollection({ schema: docsAndBlogSchema }),
};

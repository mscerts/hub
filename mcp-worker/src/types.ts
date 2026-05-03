export interface ResourceLink {
  title: string;
  href: string;
  description?: string;
  tab?: string;
}

export interface DocPage {
  slug: string;
  title: string;
  description?: string;
  category: string;
  links: ResourceLink[];
}

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  updatedDate?: string;
  authors: { name: string }[];
  tags: string[];
  readTime: number;
  body: string;
}

export interface ContentBundle {
  docs: DocPage[];
  blog: BlogPost[];
  generatedAt: string;
}

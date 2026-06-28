import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';

// Serialize metadata to YAML format
function toYAML(val: any, indent = 0): string {
  const spacing = ' '.repeat(indent);
  if (val === null || val === undefined) {
    return '';
  }
  if (typeof val !== 'object') {
    if (typeof val === 'string') {
      if (val.includes(':') || val.includes('\n') || val.includes('"') || val.includes("'")) {
        return JSON.stringify(val);
      }
      return val;
    }
    return String(val);
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return val.map(item => `\n${spacing}- ${toYAML(item, indent + 2).trim()}`).join('');
  }
  return Object.entries(val)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `\n${spacing}${k}: ${toYAML(v, indent + 2).trim()}`)
    .join('');
}

// Convert MDX components to clean Markdown using AST-based remark
async function cleanMDX(body: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(() => (tree: any) => {
      // Remove ES module import/export nodes
      tree.children = tree.children.filter((node: any) => node.type !== 'mdxjsEsm');

      // Transform JSX elements
      visit(tree, (node: any, index: number | undefined, parent: any) => {
        if (index === undefined || !parent) return;

        // Strip JSX comments ({/* comment */})
        if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') {
          if (node.value && node.value.trim().startsWith('/*') && node.value.trim().endsWith('*/')) {
            parent.children.splice(index, 1);
            return index;
          }
        }

        if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
          const name = node.name;
          const attrs: Record<string, any> = {};
          if (node.attributes) {
            for (const attr of node.attributes) {
              if (attr.type === 'mdxJsxAttribute') {
                attrs[attr.name] = attr.value;
              }
            }
          }

          // Tabs/CardGrid → flatten to children
          if (name === 'Tabs' || name === 'CardGrid') {
            parent.children.splice(index, 1, ...node.children);
            return index;
          }

          // TabItem → bold label header + children
          if (name === 'TabItem') {
            const label = attrs.label || 'Option';
            const titleNode = {
              type: 'paragraph',
              children: [{ type: 'strong', children: [{ type: 'text', value: label + ':' }] }]
            };
            parent.children.splice(index, 1, titleNode, ...node.children);
            return index;
          }

          // Aside → blockquote with type header
          if (name === 'Aside') {
            const type = (attrs.type || 'note').toUpperCase();
            const blockquoteChildren = [
              {
                type: 'paragraph',
                children: [{ type: 'strong', children: [{ type: 'text', value: type + ':' }] }]
              },
              ...node.children
            ];
            const blockquoteNode = {
              type: 'blockquote',
              children: blockquoteChildren
            };
            parent.children.splice(index, 1, blockquoteNode);
            return index;
          }

          // Card/LinkCard → heading with title
          if (name === 'Card' || name === 'LinkCard') {
            const title = attrs.title || 'Card';
            const headingNode = {
              type: 'heading',
              depth: 3,
              children: [{ type: 'text', value: title }]
            };
            parent.children.splice(index, 1, headingNode, ...node.children);
            return index;
          }

          // Other capitalized components → flatten to children
          if (name && name[0] === name[0].toUpperCase()) {
            parent.children.splice(index, 1, ...node.children);
            return index;
          }
        }
      });
    })
    .use(remarkStringify);

  const result = await processor.process(body);
  return result.toString();
}

export async function getStaticPaths() {
  const docs = await getCollection('docs');
  const isDev = import.meta.env.DEV;

  // Follow the 'draft' attribute configuration
  const publicDocs = docs.filter((entry: any) =>
    isDev || entry.data.draft !== true
  );

  const paths = publicDocs.map((entry: any) => {
    // Starlight index is empty string id, map to undefined so Astro generates root page
    const slug = entry.id === '' || entry.id === 'index' ? undefined : entry.id;
    return {
      params: { slug },
      props: { entry },
    };
  });

  // If there is no custom 404 entry in the collection, add a fallback 404 route
  const hasCustom404 = publicDocs.some((entry: any) => entry.id === '404');
  if (!hasCustom404) {
    paths.push({
      params: { slug: '404' },
      props: {
        entry: {
          id: '404',
          body: 'Page not found',
          data: {
            title: 'Page not found',
          },
        },
      },
    });
  }

  return paths;
}

export const GET: APIRoute = async ({ props }: any) => {
  const { entry } = props;

  // Keep only 'title' and 'description' in the frontmatter
  const frontmatterData: Record<string, any> = {};
  if (entry.data.title) {
    frontmatterData.title = entry.data.title;
  }
  if (entry.data.description) {
    frontmatterData.description = entry.data.description;
  }

  const yamlFrontmatter = toYAML(frontmatterData).trim();
  const cleanedBody = await cleanMDX(entry.body || '');
  const rawMarkdown = `---\n${yamlFrontmatter}\n---\n\n${cleanedBody.trim()}`;

  const is404 = entry.id === '404';

  return new Response(rawMarkdown, {
    status: is404 ? 404 : 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  });
};

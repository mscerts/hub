import { writeFile } from "node:fs/promises";

// Exact generated routes avoid wildcard rules sending unknown URLs to nonexistent pages.
export function redirectRules(redirects, pathnames) {
  const rules = new Map();
  const add = (source, target) => {
    if (source === target) return;
    rules.set(source, target);
    if (!source.endsWith(".md")) {
      rules.set(source.replace(/\/$/, "") + "/", target);
      rules.set(source.replace(/\/$/, ""), target);
    }
  };
  const docs = pathnames
    .map((path) => "/" + path.replace(/^\//, "").replace(/index\.html$/, ""))
    .filter(
      (path) =>
        path.startsWith("/certs/") &&
        path.endsWith("/") &&
        path !== "/certs/" &&
        !path.startsWith("/certs/archive/") &&
        path !== "/certs/guide/markdown/",
    );
  for (const target of docs) {
    const id = target.slice("/certs/".length, -1);
    for (const prefix of ["/", "/wiki/", "/wiki-next/"]) {
      add(`${prefix}${id}/`, target);
      add(`${prefix}${id}.md`, `/certs/${id}.md`);
    }
  }
  for (const [source, value] of Object.entries(redirects)) {
    const target = typeof value === "string" ? value : value.destination;
    add(source, target);
    // Renamed Markdown documents follow the same destination when it has a Markdown endpoint.
    if (target.startsWith("/certs/") && docs.includes(target)) {
      const old = source.replace(/\/$/, "");
      const markdown = target.replace(/\/$/, ".md");
      add(`${old}.md`, markdown);
      if (!old.startsWith("/certs/")) {
        for (const prefix of ["/wiki", "/wiki-next"]) {
          add(`${prefix}${old}/`, target);
          add(`${prefix}${old}.md`, markdown);
        }
      }
    }
  }
  add("/wiki/", "/certs/");
  add("/wiki-next/", "/certs/");
  return (
    [...rules].map(([source, target]) => `${source} ${target} 301`).join("\n") +
    "\n"
  );
}

export default function deploymentRedirects() {
  let redirects;
  return {
    name: "deployment-redirects",
    hooks: {
      "astro:config:done": ({ config }) => {
        redirects = config.redirects;
      },
      "astro:build:done": async ({ pages, dir }) => {
        await writeFile(
          new URL("_redirects", dir),
          redirectRules(
            redirects,
            pages.map(({ pathname }) => pathname),
          ),
        );
      },
    },
  };
}

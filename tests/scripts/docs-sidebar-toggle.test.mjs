import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("desktop docs sidebar preference is restored before paint", () => {
  const layout = read("src/layouts/MainLayout.astro");
  const restore = layout.indexOf(
    'localStorage.getItem("docs-sidebar:desktop:v1")',
  );
  const body = layout.indexOf("</head>");

  assert.notEqual(restore, -1);
  assert.ok(restore < body, "preference restoration runs in the head");
  assert.match(layout, /dataset\.docsSidebarCollapsed = "true"/);
});

test("desktop sidebar toggle persists state and exposes its accessible state", () => {
  const shell = read("src/components/docs/DocsShell.astro");
  const state = read("src/components/docs/client/sidebar-state.ts");

  assert.match(shell, /data-docs-sidebar-toggle/);
  assert.match(shell, /fixed left-80 top-20.*size-8/);
  assert.match(shell, /M4 5\.5h12M4 10h12M4 14\.5h12/);
  assert.match(shell, /transform: translateX\(-18\.5rem\)/);
  assert.match(shell, /aria-controls="docs-desktop-sidebar"/);
  assert.match(state, /localStorage\.setItem\(\s*desktopSidebarStorageKey/);
  assert.match(
    state,
    /toggle\.setAttribute\("aria-expanded", String\(!collapsed\)\)/,
  );
  assert.match(state, /sidebar\.toggleAttribute\("inert", collapsed\)/);
  assert.match(shell, /grid-template-columns 200ms/);
  assert.match(shell, /prefers-reduced-motion: reduce/);
});

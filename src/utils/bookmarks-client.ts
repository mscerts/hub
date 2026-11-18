import {
  cleanBookmarkTitle,
  normalizeBookmarkPath,
} from "./bookmarks-format.mjs";

export { cleanBookmarkTitle, normalizeBookmarkPath };

export interface BookmarkEntry {
  path: string;
  title: string;
  addedAt: number;
}

const STORAGE_KEY = "msfthub_bookmarks_v1";
const MAX_BOOKMARKS = 50;

export function readBookmarks(): BookmarkEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is BookmarkEntry =>
          Boolean(item) &&
          typeof item.path === "string" &&
          item.path.startsWith("/") &&
          typeof item.title === "string",
      )
      .slice(0, MAX_BOOKMARKS);
  } catch {
    return [];
  }
}

function writeBookmarks(items: BookmarkEntry[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(items.slice(0, MAX_BOOKMARKS)),
    );
  } catch {
    // Ignore storage quota or private-browsing errors
  }
}

export function toggleCurrentBookmark(
  path: string,
  title: string,
): BookmarkEntry[] {
  const normalized = normalizeBookmarkPath(path);
  const current = readBookmarks();
  const exists = current.some((entry) => entry.path === normalized);
  const next = exists
    ? current.filter((entry) => entry.path !== normalized)
    : [
        {
          path: normalized,
          title: cleanBookmarkTitle(title),
          addedAt: Date.now(),
        },
        ...current,
      ];
  writeBookmarks(next);
  return next;
}

export function removeBookmark(path: string): BookmarkEntry[] {
  const normalized = normalizeBookmarkPath(path);
  const next = readBookmarks().filter((entry) => entry.path !== normalized);
  writeBookmarks(next);
  return next;
}

let initialized = false;

export function initBookmarksUI(): void {
  if (initialized || typeof document === "undefined") return;
  initialized = true;

  const currentPath = normalizeBookmarkPath(window.location.pathname);
  const getCurrentTitle = (): string => {
    const h1 = document.querySelector("main h1")?.textContent?.trim();
    return cleanBookmarkTitle(h1 || document.title);
  };

  const renderAll = () => {
    const items = readBookmarks();
    const isSaved = items.some((item) => item.path === currentPath);

    document
      .querySelectorAll<HTMLElement>("[data-bookmarks-count]")
      .forEach((badge) => {
        badge.textContent = String(items.length);
        badge.hidden = items.length === 0;
      });

    document
      .querySelectorAll<HTMLButtonElement>("[data-bookmarks-menu-toggle]")
      .forEach((btn) => {
        btn.classList.toggle("text-blue-700", isSaved);
        btn.classList.toggle("dark:text-blue-300", isSaved);
      });

    document
      .querySelectorAll<HTMLButtonElement>("[data-bookmark-page-btn]")
      .forEach((btn) => {
        btn.setAttribute("aria-pressed", String(isSaved));
        const label = btn.querySelector<HTMLElement>(
          "[data-bookmark-page-label]",
        );
        if (label) {
          label.textContent =
            btn.dataset.bookmarkVariant === "menu"
              ? isSaved
                ? "Saved — remove this page"
                : "Bookmark this page"
              : isSaved
                ? "Saved"
                : "Save";
        }
      });

    document
      .querySelectorAll<HTMLElement>("[data-bookmarks-list]")
      .forEach((container) => {
        container.replaceChildren();
        if (items.length === 0) {
          const empty = document.createElement("p");
          empty.className =
            "px-3 py-3 text-xs text-neutral-500 dark:text-neutral-400";
          empty.textContent =
            "No saved pages yet. Bookmark exams, courses, labs, or vouchers for quick access.";
          container.appendChild(empty);
          return;
        }

        for (const entry of items) {
          const row = document.createElement("div");
          row.className =
            "group flex items-center justify-between gap-1 rounded-xl px-2.5 py-2 transition hover:bg-neutral-100 dark:hover:bg-neutral-800";

          const link = document.createElement("a");
          link.href = entry.path;
          link.className =
            "min-w-0 flex-1 no-underline focus-visible:ring-2 focus-visible:ring-orange-700 focus-visible:outline-none dark:focus-visible:ring-orange-300";

          const titleEl = document.createElement("span");
          titleEl.className =
            "block truncate text-sm font-semibold text-neutral-800 group-hover:text-blue-700 dark:text-neutral-200 dark:group-hover:text-blue-300";
          titleEl.textContent = entry.title;

          const pathEl = document.createElement("span");
          pathEl.className =
            "block truncate text-[0.7rem] text-neutral-500 dark:text-neutral-400";
          pathEl.textContent = entry.path;

          link.append(titleEl, pathEl);

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className =
            "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-orange-700 focus-visible:outline-none dark:hover:bg-neutral-700 dark:hover:text-white dark:focus-visible:ring-orange-300";
          removeBtn.setAttribute(
            "aria-label",
            `Remove bookmark for ${entry.title}`,
          );
          removeBtn.title = "Remove bookmark";
          removeBtn.textContent = "×";
          removeBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeBookmark(entry.path);
            renderAll();
          });

          row.append(link, removeBtn);
          container.appendChild(row);
        }
      });
  };

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const toggleBtn = event.target.closest<HTMLButtonElement>(
      "[data-bookmark-page-btn]",
    );
    if (!toggleBtn) return;
    event.preventDefault();
    toggleCurrentBookmark(currentPath, getCurrentTitle());
    renderAll();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) renderAll();
  });

  renderAll();
}

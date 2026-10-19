const groupStorageKey = "docs-sidebar:groups:v1";

function readState(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    // Storage can be unavailable in private or restricted browsing contexts.
    return null;
  }
}

function writeState(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Navigation remains functional when session persistence is unavailable.
  }
}

function setExpanded(group: HTMLElement, open: boolean) {
  const button = group.querySelector<HTMLButtonElement>(
    ":scope > button[aria-controls]",
  );
  const panel = group.querySelector<HTMLElement>(":scope > [role=region]");
  if (!button || !panel) return;
  group.classList.toggle("active", open);
  button.setAttribute("aria-expanded", String(open));
  panel.classList.toggle("hidden", !open);
  panel.hidden = !open;
}

export default function initializeSidebarState() {
  document
    .querySelectorAll<HTMLElement>("[data-docs-sidebar-scroll]")
    .forEach((scroller) => {
      if (scroller.dataset.sidebarStateReady) return;
      scroller.dataset.sidebarStateReady = "true";
      const storageKey = `docs-sidebar:scroll:v1:${scroller.dataset.docsSidebarScroll}`;
      const storedGroups = readState(groupStorageKey);
      const groups = scroller.querySelectorAll<HTMLElement>(
        "[data-docs-group-key]",
      );

      groups.forEach((group) => {
        const key = group.dataset.docsGroupKey!;
        const stored =
          storedGroups && typeof storedGroups === "object"
            ? (storedGroups as Record<string, unknown>)[key]
            : undefined;
        const containsCurrent = Boolean(
          group.querySelector('[aria-current="page"]'),
        );
        setExpanded(
          group,
          containsCurrent ||
            (typeof stored === "boolean"
              ? stored
              : group.classList.contains("active")),
        );
        group
          .querySelector<HTMLButtonElement>(":scope > button")
          ?.addEventListener("click", () => {
            const open = !group.classList.contains("active");
            const previous = readState(groupStorageKey);
            const state =
              previous &&
              typeof previous === "object" &&
              !Array.isArray(previous)
                ? (previous as Record<string, unknown>)
                : {};
            state[key] = open;
            writeState(groupStorageKey, state);
            document
              .querySelectorAll<HTMLElement>("[data-docs-group-key]")
              .forEach((copy) => {
                if (copy.dataset.docsGroupKey === key) setExpanded(copy, open);
              });
          });
      });

      let restored = false;
      const save = () => {
        if (restored && scroller.getClientRects().length) {
          writeState(storageKey, {
            top: scroller.scrollTop,
            path: location.pathname,
          });
        }
      };
      const restore = () => {
        if (
          restored ||
          !scroller.getClientRects().length ||
          scroller.clientHeight === 0
        )
          return;
        const saved = readState(storageKey) as {
          top?: unknown;
          path?: unknown;
        } | null;
        if (
          saved &&
          typeof saved.top === "number" &&
          Number.isFinite(saved.top)
        ) {
          scroller.scrollTop = Math.max(0, saved.top);
        }
        if (!saved || saved.path !== location.pathname) {
          const current = scroller.querySelector<HTMLElement>(
            '[data-docs-nav-item][aria-current="page"]',
          );
          if (current) {
            const bounds = scroller.getBoundingClientRect();
            const link = current.getBoundingClientRect();
            if (link.top < bounds.top || link.bottom > bounds.bottom) {
              scroller.scrollTop +=
                link.top -
                bounds.top -
                (scroller.clientHeight - link.height) / 2;
            }
          }
        }
        restored = true;
      };

      scroller.addEventListener("scroll", save, { passive: true });
      scroller.addEventListener("click", save, { capture: true });
      scroller.addEventListener("docs:sidebar-open", restore);
      window.addEventListener("pagehide", save);
      const onResize = () => requestAnimationFrame(restore);
      window.addEventListener("resize", onResize);
      requestAnimationFrame(restore);
    });
}

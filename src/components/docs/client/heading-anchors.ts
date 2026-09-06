let liveRegion: HTMLElement | null = null;

function announce(message: string) {
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    Object.assign(liveRegion.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      padding: "0",
      margin: "-1px",
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
      border: "0",
    });
    document.body.appendChild(liveRegion);
  }

  liveRegion.textContent = "";
  liveRegion.textContent = message;
}

function applyHeadingAnchors() {
  document
    .querySelectorAll<HTMLElement>(".docs-content :is(h2, h3, h4)[id]")
    .forEach((heading) => {
      if (heading.hasAttribute("data-heading-anchor-ready")) return;
      heading.setAttribute("data-heading-anchor-ready", "true");

      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.className = "heading-anchor";
      const title = heading.textContent?.trim() ?? "section";
      link.setAttribute("aria-label", `Copy link to ${title}`);

      const label = document.createElement("span");
      label.className = "heading-anchor-label";
      while (heading.firstChild) label.appendChild(heading.firstChild);

      const icon = document.createElement("span");
      icon.className = "heading-anchor-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07.07l1.42-1.42a5 5 0 0 0-7.07-7.07L10.6 6.4"/><path d="M14 11a5 5 0 0 0-7.07-.07l-1.42 1.42a5 5 0 1 0 7.07 7.07l.82-.82"/></svg>';

      link.append(label, icon);
      heading.appendChild(link);

      link.addEventListener("click", () => {
        const url = new URL(
          link.getAttribute("href") ?? `#${heading.id}`,
          location.href,
        ).href;
        navigator.clipboard?.writeText(url).then(
          () => announce("Link copied to clipboard"),
          () => {},
        );
      });
    });
}

export function headingAnchors(): void {
  applyHeadingAnchors();
  document.addEventListener("astro:page-load", applyHeadingAnchors);
}

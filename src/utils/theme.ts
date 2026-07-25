type Theme = "light" | "dark";

const LS_KEYS = { preline: "hs_theme", starlight: "starlight-theme" } as const;

export function getTheme(): Theme {
  const raw =
    localStorage.getItem(LS_KEYS.preline) ||
    localStorage.getItem(LS_KEYS.starlight);
  if (raw === "light" || raw === "dark") return raw;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(LS_KEYS.preline, theme);
  localStorage.setItem(LS_KEYS.starlight, theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
}

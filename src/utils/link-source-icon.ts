const platforms: [string, string][] = [
  ["microsoft.com", "simple-icons:microsoft"],
  ["microsoft.github.io", "simple-icons:microsoft"],
  ["skillupwithlevelup.com", "simple-icons:microsoft"],
  ["youtube.com", "simple-icons:youtube"],
  ["youtu.be", "simple-icons:youtube"],
  ["udemy.com", "simple-icons:udemy"],
  ["pluralsight.com", "simple-icons:pluralsight"],
  ["github.com", "simple-icons:github"],
  ["github.io", "simple-icons:github"],
  ["linkedin.com", "simple-icons:linkedin"],
  ["reddit.com", "simple-icons:reddit"],
  ["discord.com", "simple-icons:discord"],
  ["discord.gg", "simple-icons:discord"],
  ["coursera.org", "simple-icons:coursera"],
  ["datacamp.com", "simple-icons:datacamp"],
  ["medium.com", "simple-icons:medium"],
  ["stackoverflow.com", "simple-icons:stackoverflow"],
  ["vimeo.com", "simple-icons:vimeo"],
  ["twitch.tv", "simple-icons:twitch"],
  ["measureup.com", "ph:exam"],
  ["whizlabs.com", "ph:exam"],
];

/**
 * The host whose icon a link shows. Microsoft's short links to its course
 * recordings (https://aka.ms/AZ-104onYouTube) are YouTube playlists to a reader,
 * so they show the YouTube icon; every other link shows its own host's.
 */
export function iconHostname(url: URL): string {
  if (url.hostname === "aka.ms" && /onyoutube\/?$/i.test(url.pathname)) {
    return "www.youtube.com";
  }
  return url.hostname;
}

export function linkSourceIcon(href: string): string {
  if (!/^(?:https?:)?\/\//i.test(href)) return "ph:book-open-text";

  try {
    const hostname = iconHostname(new URL(href, "https://msfthub.com"));
    if (hostname === "msfthub.com" || hostname === "www.msfthub.com") {
      return "ph:book-open-text";
    }
    return (
      platforms.find(
        ([domain]) => hostname === domain || hostname.endsWith(`.${domain}`),
      )?.[1] ?? "ph:globe"
    );
  } catch {
    return "ph:globe";
  }
}

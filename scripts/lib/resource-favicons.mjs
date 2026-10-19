import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import https from "node:https";
import { parse } from "parse5";
import sharp from "sharp";
import ico from "sharp-ico";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
])
  blocked.addSubnet(address, prefix, "ipv6");

export function publicAddress(address, family) {
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return false;
  return !blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

export async function download(url, limit, redirects = 0) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    (target.port && target.port !== "443")
  )
    throw new Error("Only public HTTPS URLs are accepted");
  const addresses = await lookup(target.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address, family }) => !publicAddress(address, family))
  )
    throw new Error("Non-public address rejected");
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(
      target,
      {
        agent: false,
        family: address.family,
        autoSelectFamily: false,
        headers: {
          "User-Agent": "msfthub-favicon-sync/1.0 (+https://msfthub.com)",
          "Accept-Encoding": "identity",
        },
        // Pin the checked address so a second DNS lookup cannot change the destination.
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.destroy();
          if (redirects >= 4) return reject(new Error("Too many redirects"));
          download(
            new URL(response.headers.location, target),
            limit,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit) {
            response.destroy(new Error("Download exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ buffer: Buffer.concat(chunks), url: target.href }),
        );
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Download timed out")),
      8000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("socket", (socket) => socket.on("error", reject));
    request.on("error", reject);
  });
}

export function faviconCandidates(html, pageUrl) {
  const document = parse(html);
  const candidates = [];
  const walk = (node) => {
    if (node.tagName === "link") {
      const attrs = Object.fromEntries(
        node.attrs.map(({ name, value }) => [name, value]),
      );
      const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
      if (
        (rel.includes("icon") || rel.includes("apple-touch-icon")) &&
        attrs.href
      ) {
        try {
          const url = new URL(attrs.href, pageUrl);
          if (url.protocol === "https:") candidates.push(url.href);
        } catch {
          /* A malformed icon declaration does not suppress the fallback. */
        }
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(document);
  return [...new Set([...candidates, new URL("/favicon.ico", pageUrl).href])];
}

export async function normalizeFavicon(buffer) {
  const options = { limitInputPixels: 1024 * 1024, density: 96 };
  const isIco = buffer.length >= 4 && buffer.readUInt32LE(0) === 65536;
  let image;
  if (isIco) {
    const images = ico.sharpsFromIco(buffer, options);
    const sizes = await Promise.all(
      images.map(async (entry) => ({
        image: entry,
        width: (await entry.metadata()).width ?? 0,
      })),
    );
    image = sizes.sort((a, b) => b.width - a.width)[0]?.image;
    if (!image) throw new Error("Empty ICO file");
  } else image = sharp(buffer, options);
  return image
    .resize(32, 32, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .grayscale()
    .png()
    .toBuffer();
}

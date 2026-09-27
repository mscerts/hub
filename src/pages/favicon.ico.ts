import type { APIRoute } from "astro";
import sharp from "sharp";
import ico from "sharp-ico";
import path from "node:path";

const faviconSrc = path.resolve("src/assets/images/favicon.svg");
const sizes = [16, 32];

// Retry once: concurrent sharp/libvips calls elsewhere in the dev server can intermittently throw "colourspace: parameter space not set".
async function renderSize(size: number): Promise<Buffer> {
  try {
    return await sharp(faviconSrc).resize(size).toFormat("png").toBuffer();
  } catch {
    return await sharp(faviconSrc).resize(size).toFormat("png").toBuffer();
  }
}

async function buildIcoBuffer(): Promise<Buffer> {
  // Sequential, not Promise.all: avoids racing sharp against itself on the same source.
  const buffers: Buffer[] = [];
  for (const size of sizes) {
    buffers.push(await renderSize(size));
  }
  return ico.encode(buffers);
}

// Cache across requests so this only ever runs once per server process.
let icoPromise: Promise<Buffer> | null = null;

export const GET: APIRoute = async () => {
  if (!icoPromise) {
    icoPromise = buildIcoBuffer().catch((err) => {
      icoPromise = null;
      throw err;
    });
  }

  const icoBuffer = await icoPromise;

  return new Response(new Uint8Array(icoBuffer), {
    headers: { "Content-Type": "image/x-icon" },
  });
};

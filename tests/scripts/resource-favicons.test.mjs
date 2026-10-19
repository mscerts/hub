import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import ico from "sharp-ico";
import { linkSourceIcon } from "../../src/utils/link-source-icon.ts";
import { readFile } from "node:fs/promises";
import {
  faviconCandidates,
  publicAddress,
  normalizeFavicon,
  download,
} from "../../scripts/lib/resource-favicons.mjs";

test("each committed manifest entry has a matching local grayscale PNG", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(
    await readFile(
      new URL("src/data_files/resource-favicons.json", root),
      "utf8",
    ),
  );
  for (const [hostname, entry] of Object.entries(manifest)) {
    assert.equal(new URL(`https://${hostname}`).hostname, hostname);
    assert.match(
      entry.path,
      /^\/resource-favicons\/[a-z0-9.-]+-[a-f0-9]{16}\.png$/,
    );
    const image = sharp(await readFile(new URL(`public${entry.path}`, root)));
    const metadata = await image.metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 32);
    const { data } = await image
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let index = 0; index < data.length; index += 3) {
      assert.equal(data[index], data[index + 1], hostname);
      assert.equal(data[index], data[index + 2], hostname);
    }
  }
});

test("favicon discovery resolves relative URLs, decodes attributes and retains a deduplicated fallback", () => {
  assert.deepEqual(
    faviconCandidates(
      '<link href="/icon.png?v=1&amp;x=2" rel="shortcut icon"><link rel="apple-touch-icon" href="https://cdn.example.org/apple.png"><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="/favicon.ico">',
      "https://example.org/path/",
    ),
    [
      "https://example.org/icon.png?v=1&x=2",
      "https://cdn.example.org/apple.png",
      "https://example.org/favicon.ico",
    ],
  );
  assert.deepEqual(faviconCandidates("", "https://example.org/"), [
    "https://example.org/favicon.ico",
  ]);
});

test("public address validation permits ordinary IPv4 and IPv6, rejects local and mapped addresses", () => {
  assert.equal(publicAddress("8.8.8.8", 4), true);
  assert.equal(publicAddress("2606:4700:4700::1111", 6), true);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
  ])
    assert.equal(publicAddress(address, 4), false, address);
  for (const address of ["::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"])
    assert.equal(publicAddress(address, 6), false, address);
});

test("downloads reject non-HTTPS and credentialed URLs before requesting them", async () => {
  await assert.rejects(download("http://example.org/icon.png", 1000), /HTTPS/);
  await assert.rejects(
    download("https://user:password@example.org/icon.png", 1000),
    /HTTPS/,
  );
});

test("Google cached fallback requests the favicon of the requested hostname", () => {
  const url = new URL(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent("trk.udemy.com")}&sz=64`,
  );
  assert.equal(url.hostname, "www.google.com");
  assert.equal(url.searchParams.get("domain"), "trk.udemy.com");
  assert.equal(url.searchParams.get("sz"), "64");
});

test("Microsoft Learn links retain the monochrome Windows icon rather than the host favicon", () => {
  assert.equal(
    linkSourceIcon("https://learn.microsoft.com/training/modules/example/"),
    "simple-icons:microsoft",
  );
  assert.equal(
    linkSourceIcon("https://sub.learn.microsoft.com/example"),
    "simple-icons:microsoft",
  );
});

test("PNG and ICO input normalize to local 32px grayscale PNGs", async () => {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 4, background: "#ed2040" },
  })
    .png()
    .toBuffer();
  for (const input of [png, ico.encode([png])]) {
    const normalized = await normalizeFavicon(input);
    const metadata = await sharp(normalized).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 32);
    const { data, info } = await sharp(normalized)
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 3);
    for (let index = 0; index < data.length; index += 3) {
      assert.equal(data[index], data[index + 1]);
      assert.equal(data[index], data[index + 2]);
    }
  }
  await assert.rejects(normalizeFavicon(Buffer.from("not an image")));
});

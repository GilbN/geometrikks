import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { encodeAll } from "../scripts/encode-screenshots";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function writePng(path: string, width: number, height: number): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .png()
    .toFile(path);
}

async function writeNoisePng(path: string): Promise<void> {
  const noise = Buffer.alloc(200 * 200 * 3);
  for (let index = 0; index < noise.length; index++) noise[index] = (index * 7919) % 251;
  await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } }).png().toFile(path);
}

describe("encodeAll", () => {
  test("encodes each PNG to a WebP named after it and reports its size", async () => {
    const pngDir = tempDir("encode-png-");
    const webpDir = tempDir("encode-webp-");
    await writePng(join(pngDir, "login-desktop-dark.png"), 40, 20);

    const encoded = await encodeAll(pngDir, webpDir);

    expect(Object.keys(encoded)).toEqual(["login-desktop-dark"]);
    expect(encoded["login-desktop-dark"]).toMatchObject({ width: 40, height: 20 });
    expect(encoded["login-desktop-dark"].bytes).toBeGreaterThan(0);
    const meta = await sharp(join(webpDir, "login-desktop-dark.webp")).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 40, height: 20 });
  });

  test("ignores files that are not PNGs", async () => {
    const pngDir = tempDir("encode-png-");
    const webpDir = tempDir("encode-webp-");
    await writePng(join(pngDir, "status-phone-light.png"), 40, 20);
    writeFileSync(join(pngDir, "notes.txt"), "not an image");

    const encoded = await encodeAll(pngDir, webpDir);

    expect(Object.keys(encoded)).toEqual(["status-phone-light"]);
    expect(readdirSync(webpDir)).toEqual(["status-phone-light.webp"]);
    expect(existsSync(join(webpDir, "notes.webp"))).toBe(false);
  });

  test("a lower quality gives a smaller file", async () => {
    const pngDir = tempDir("encode-png-");
    const high = tempDir("encode-webp-");
    const low = tempDir("encode-webp-");
    await writeNoisePng(join(pngDir, "a.png"));

    const best = await encodeAll(pngDir, high, { quality: 95 });
    const worst = await encodeAll(pngDir, low, { quality: 20 });

    expect(worst.a.bytes).toBeLessThan(best.a.bytes);
  });

  test("defaults to quality 82 and effort 5", async () => {
    const pngDir = tempDir("encode-png-");
    const plain = tempDir("encode-webp-");
    const explicit = tempDir("encode-webp-");
    await writeNoisePng(join(pngDir, "a.png"));

    const byDefault = await encodeAll(pngDir, plain);
    const stated = await encodeAll(pngDir, explicit, { quality: 82, effort: 5 });

    expect(byDefault.a.bytes).toBe(stated.a.bytes);
  });
});

describe("the CLI", () => {
  test("prints only the JSON record on stdout", async () => {
    const pngDir = tempDir("encode-png-");
    const webpDir = tempDir("encode-webp-");
    await writePng(join(pngDir, "map-phone-dark.png"), 40, 20);

    const result = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/encode-screenshots.ts"), pngDir, webpDir]);

    expect(result.exitCode).toBe(0);
    const record = JSON.parse(result.stdout.toString());
    expect(Object.keys(record)).toEqual(["map-phone-dark"]);
    expect(record["map-phone-dark"]).toMatchObject({ width: 40, height: 20 });
  });

  test("exits 2 with usage when an argument is missing", () => {
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/encode-screenshots.ts")]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
  });
});

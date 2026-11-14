import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";

export type Encoded = { width: number; height: number; bytes: number };

export async function encodeAll(
  pngDir: string,
  webpDir: string,
  opts: { quality?: number; effort?: number } = {},
): Promise<Record<string, Encoded>> {
  const quality = opts.quality ?? 82;
  const effort = opts.effort ?? 5;
  const names = readdirSync(pngDir)
    .filter((file) => file.endsWith(".png"))
    .sort();
  const encoded: Record<string, Encoded> = {};
  for (const file of names) {
    const name = basename(file, ".png");
    const info = await sharp(join(pngDir, file))
      .webp({ quality, effort })
      .toFile(join(webpDir, `${name}.webp`));
    encoded[name] = { width: info.width, height: info.height, bytes: info.size };
  }
  return encoded;
}

if (import.meta.main) {
  const [pngDir, webpDir] = process.argv.slice(2);
  if (!pngDir || !webpDir) {
    console.error("usage: bun site/scripts/encode-screenshots.ts <pngDir> <webpDir>");
    process.exit(2);
  }
  console.log(JSON.stringify(await encodeAll(pngDir, webpDir)));
}

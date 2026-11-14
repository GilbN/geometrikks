export type ShotVariant = { file: string; width: number; height: number };
export type SceneEntry = { title: string; alt: string; variants: Record<string, ShotVariant> };
export type Manifest = { version: 1; scenes: Record<string, SceneEntry> };

export function sceneEntry(manifest: Manifest, id: string): SceneEntry {
  const entry = manifest.scenes[id];
  if (!entry) throw new Error(`unknown screenshot scene: ${id}`);
  return entry;
}

export function variant(
  entry: SceneEntry,
  viewport: "desktop" | "phone" | "landscape",
  theme: "dark" | "light",
): ShotVariant | undefined {
  return entry.variants[`${viewport}-${theme}`];
}

export function shotSrc(v: ShotVariant): string {
  return `/screenshots/${v.file}`;
}

export function manifestFiles(manifest: Manifest): string[] {
  return Object.values(manifest.scenes).flatMap((entry) => Object.values(entry.variants).map((v) => v.file));
}

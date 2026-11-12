import screenshots from "@/.generated/screenshots.json";
import { type Manifest, type SceneEntry, sceneEntry, type ShotVariant, shotSrc, variant } from "@/lib/screenshots";
import styles from "./ShotPair.module.css";

const manifest = screenshots as Manifest;

type ShotPairProps = {
  scene: string;
  phoneScene?: string;
  theme?: "dark" | "auto";
  caption?: string;
  zoom?: boolean;
};

type Variants = { theme: "dark" | "light"; shot: ShotVariant }[];

function variants(entry: SceneEntry, viewport: "desktop" | "phone", themes: ("dark" | "light")[]): Variants {
  return themes.flatMap((theme) => {
    const shot = variant(entry, viewport, theme);
    return shot ? [{ theme, shot }] : [];
  });
}

// A desktop shot with the phone shot beside it. theme="auto" renders both
// themes and docs.css hides the one that does not match html.dark.
export function ShotPair({ scene, phoneScene, theme = "auto", caption, zoom = false }: ShotPairProps) {
  const entry = sceneEntry(manifest, scene);
  const phoneEntry = sceneEntry(manifest, phoneScene ?? scene);
  const themes: ("dark" | "light")[] = theme === "dark" ? ["dark"] : ["light", "dark"];
  const themeClass = (shotTheme: "dark" | "light") => (theme === "auto" ? `shot-${shotTheme}` : undefined);
  const desktop = variants(entry, "desktop", themes);
  const phone = variants(phoneEntry, "phone", themes);

  const image = (shot: ShotVariant, alt: string, className?: string, key?: string) => (
    <img
      key={key}
      className={className}
      src={shotSrc(shot)}
      width={shot.width}
      height={shot.height}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );

  return (
    <figure className={styles.figure}>
      <div className={desktop.length > 0 && phone.length > 0 ? styles.pair : styles.single}>
        {desktop.length > 0 && (
          <div className={styles.desktop}>
            {desktop.map(({ theme: shotTheme, shot }) =>
              zoom ? (
                <a
                  key={shotTheme}
                  className={`zoom ${themeClass(shotTheme) ?? ""}`.trim()}
                  href={shotSrc(shot)}
                  data-zoom=""
                  data-zoom-alt={entry.alt}
                  data-zoom-caption={caption ?? entry.title}
                  aria-label={`View the ${entry.title} screenshot larger`}
                >
                  {image(shot, entry.alt, themeClass(shotTheme))}
                  <ZoomHint />
                </a>
              ) : (
                image(shot, entry.alt, themeClass(shotTheme), shotTheme)
              ),
            )}
          </div>
        )}
        {phone.length > 0 && (
          <div className={styles.phone}>
            {phone.map(({ theme: shotTheme, shot }) => image(shot, phoneEntry.alt, themeClass(shotTheme), shotTheme))}
          </div>
        )}
      </div>
      {caption && !zoom && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}

export function ZoomHint() {
  return (
    <span className="hint" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
      </svg>
      Enlarge
    </span>
  );
}

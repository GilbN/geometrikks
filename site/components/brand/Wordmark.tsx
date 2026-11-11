// Ported from resources/components/brand/wordmark.tsx: GEOMETRI + the hagall
// ligature standing in for KK + S, in runr. The ligature is always inline SVG;
// runr has no runic glyphs.
type Props = {
  size?: number;
  className?: string;
  title?: string;
};

export function Wordmark({ size, className, title = "GeoMetrikks" }: Props) {
  return (
    <span
      className={className ? `wordmark ${className}` : "wordmark"}
      style={size === undefined ? undefined : { fontSize: size }}
      role="img"
      aria-label={title}
    >
      <span aria-hidden="true">GEOMETRI</span>
      <svg className="lig" viewBox="0 0 10 14" fill="none" stroke="var(--accent)" strokeWidth="1.5" aria-hidden="true">
        <line x1="5" y1="0.75" x2="5" y2="13.25" />
        <line x1="0.9" y1="3.6" x2="9.1" y2="10.4" />
        <line x1="0.9" y1="10.4" x2="9.1" y2="3.6" />
      </svg>
      <span aria-hidden="true">S</span>
    </span>
  );
}

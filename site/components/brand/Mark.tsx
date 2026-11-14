// Ported from resources/components/brand/brand-mark.tsx (full variant).
// Keep the geometry in sync with the app.
type Props = {
  size?: number;
  className?: string;
  title?: string;
};

const cardinals = [90, 180, 270];
const diagonals = [45, 135, 225, 315];

export function Mark({ size = 24, className, title = "GeoMetrikks" }: Props) {
  return (
    <svg role="img" aria-label={title} width={size} height={size} viewBox="0 0 100 100" className={className}>
      <circle
        cx="50"
        cy="50"
        r="44"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.2"
        strokeDasharray="0.5 5"
        strokeLinecap="round"
      />
      <g stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="square">
        {cardinals.map((rotation) => (
          <g key={rotation} transform={`rotate(${rotation} 50 50)`}>
            <line x1="50" y1="41" x2="50" y2="10" />
            <line x1="50" y1="16" x2="44" y2="10" />
            <line x1="50" y1="16" x2="56" y2="10" />
            <line x1="45.5" y1="23" x2="54.5" y2="23" />
          </g>
        ))}
        {diagonals.map((rotation) => (
          <g key={rotation} transform={`rotate(${rotation} 50 50)`}>
            <line x1="50" y1="41" x2="50" y2="22" />
          </g>
        ))}
        <circle cx="50" cy="50" r="5.5" />
      </g>
      <g stroke="var(--accent)" strokeWidth="3" fill="none" strokeLinecap="square">
        <line x1="50" y1="41" x2="50" y2="10" />
        <line x1="50" y1="16" x2="44" y2="10" />
        <line x1="50" y1="16" x2="56" y2="10" />
        <line x1="45.5" y1="23" x2="54.5" y2="23" />
      </g>
      <circle cx="50" cy="6" r="3" fill="var(--accent)" />
      <circle cx="50" cy="50" r="1.9" fill="var(--accent)" />
    </svg>
  );
}

import { cn } from "@/lib/utils"

const CARDINALS = [90, 180, 270]
const DIAGONALS = [45, 135, 225, 315]

function ForkTickArm({ rotate }: { rotate?: number }) {
  return (
    <g transform={rotate ? `rotate(${rotate} 50 50)` : undefined}>
      <line x1="50" y1="41" x2="50" y2="10" />
      <line x1="50" y1="16" x2="44" y2="10" />
      <line x1="50" y1="16" x2="56" y2="10" />
      <line x1="45.5" y1="23" x2="54.5" y2="23" />
    </g>
  )
}

/**
 * The GeoMetrikks wayfinder mark (Vegvisir-D): fork-and-tick cardinal staves,
 * plain diagonals, dotted ring, accent north arm, map-pin center.
 * `variant="small"` is the simplified sibling for <=24px contexts (favicon
 * geometry): plain arms only, no ring/forks/ticks.
 */
export function BrandMark({
  size = 24,
  variant = "full",
  className,
  title = "GeoMetrikks",
  decorative = false,
}: {
  size?: number
  variant?: "full" | "small"
  className?: string
  title?: string
  decorative?: boolean
}) {
  const a11yProps = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": title }

  if (variant === "small") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className={cn("shrink-0", className)}
        {...a11yProps}
      >
        <g stroke="currentColor" strokeWidth="8" fill="none" strokeLinecap="square">
          {CARDINALS.map((r) => (
            <g key={r} transform={`rotate(${r} 50 50)`}>
              <line x1="50" y1="44" x2="50" y2="8" />
            </g>
          ))}
          {DIAGONALS.map((r) => (
            <g key={r} transform={`rotate(${r} 50 50)`}>
              <line x1="50" y1="44" x2="50" y2="18" />
            </g>
          ))}
        </g>
        <g stroke="var(--primary)" strokeWidth="9" fill="none" strokeLinecap="square">
          <line x1="50" y1="44" x2="50" y2="6" />
        </g>
        <circle cx="50" cy="50" r="7" fill="var(--primary)" />
      </svg>
    )
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
      {...a11yProps}
    >
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
        {CARDINALS.map((r) => (
          <ForkTickArm key={r} rotate={r} />
        ))}
        {DIAGONALS.map((r) => (
          <g key={r} transform={`rotate(${r} 50 50)`}>
            <line x1="50" y1="41" x2="50" y2="22" />
          </g>
        ))}
        <circle cx="50" cy="50" r="5.5" />
      </g>
      <g stroke="var(--primary)" strokeWidth="3" fill="none" strokeLinecap="square">
        <ForkTickArm />
      </g>
      <circle cx="50" cy="6" r="3" fill="var(--primary)" />
      <circle cx="50" cy="50" r="1.9" fill="var(--primary)" />
    </svg>
  )
}

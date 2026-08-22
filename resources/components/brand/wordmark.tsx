import { cn } from "@/lib/utils"

/** The hagall-style KK ligature: two mirrored K's fused on one stem
 * (visually U+16BC). Always an inline SVG - the runr font is locked and
 * has no runic glyphs. Height tracks the surrounding font size. */
function HagallLigature({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 10 14"
      fill="none"
      stroke="var(--primary)"
      strokeWidth="1.5"
      // The parent's tracking lands after the I but not after this SVG, so the
      // right margin carries the 0.13em the S would otherwise lose.
      className={cn("inline-block h-[0.78em] w-auto ml-[0.06em] mr-[0.19em] align-baseline", className)}
      aria-hidden
    >
      <line x1="5" y1="0.75" x2="5" y2="13.25" />
      <line x1="0.9" y1="3.6" x2="9.1" y2="10.4" />
      <line x1="0.9" y1="10.4" x2="9.1" y2="3.6" />
    </svg>
  )
}

/**
 * The GeoMetrikks wordmark: GEOMETRI + hagall ligature (stands in for KK,
 * the X sound) + S, in runr. Size via className font-size; defaults suit
 * the sidebar. `sub` renders the ANALYTICS line beneath.
 */
export function Wordmark({
  className,
  sub = false,
}: {
  className?: string
  sub?: boolean
}) {
  return (
    <span className={cn("flex flex-col", className)}>
      <span
        className="font-runr font-normal uppercase tracking-[0.13em] whitespace-nowrap leading-none inline-flex items-center"
        role="img"
        aria-label="GeoMetrikks"
      >
        <span aria-hidden>GEOMETRI</span>
        <HagallLigature />
        <span aria-hidden>S</span>
      </span>
      {sub && (
        <span className="font-runr font-normal uppercase tracking-[0.25em] text-[0.44em] opacity-50 whitespace-nowrap mt-[0.3em]">
          ANALYTICS
        </span>
      )}
    </span>
  )
}

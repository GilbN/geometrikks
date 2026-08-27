/** Class fragments shared by the data primitives so they read as one
 * family and match Card's surface: ring border, card shadow, xl radius. */
export const FRAME_SURFACE =
  "min-w-0 overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-border shadow-[var(--shadow-card)]"

/** The design-system data-card label; the same string CardTitle callers use. */
export const FRAME_LABEL = "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"

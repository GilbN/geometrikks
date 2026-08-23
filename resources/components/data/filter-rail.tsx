import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FRAME_SURFACE } from "./frame"

/**
 * Bounded desktop container for a page's filters. The label is only the
 * region's accessible name; the page header above already says what the
 * card filters. `activeCount` counts logical groups (one per populated
 * multi-select or text field), never individual chips, and shows on the
 * Clear button. Children are FilterRows; a page with few controls uses one
 * row, a page with many decides which controls share a row.
 */
export function FilterRail({
  label,
  activeCount = 0,
  onClear,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "aria-label"> & {
  label: string
  activeCount?: number
  onClear?: () => void
}) {
  return (
    <div
      data-slot="filter-rail"
      role="region"
      aria-label={label}
      className={cn(FRAME_SURFACE, "flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">{children}</div>
      {onClear && activeCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-8 self-start pointer-coarse:h-11 sm:self-center"
        >
          Clear {activeCount} {activeCount === 1 ? "filter" : "filters"}
        </Button>
      )}
    </div>
  )
}

/** One line of controls. Wraps only when the viewport is too narrow. */
export function FilterRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="filter-row"
      className={cn("flex flex-wrap items-end gap-x-3 gap-y-2", className)}
      {...props}
    />
  )
}

const FIELD_LABEL = "text-[10px] font-medium uppercase leading-4 tracking-[0.06em] text-muted-foreground"

/**
 * A labeled control. The same component renders on the desktop rail and in
 * the mobile drawer; the drawer's flex column stretches it to full width.
 * `hideLabel` is for controls that already name themselves, like a select
 * trigger, where a label would just repeat the button text; the label is
 * still the control's accessible name.
 */
export function FilterField({
  label,
  hideLabel = false,
  children,
  className,
}: {
  label: string
  hideLabel?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <label data-slot="filter-field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className={cn(FIELD_LABEL, hideLabel && "sr-only")}>{label}</span>
      {children}
    </label>
  )
}

/**
 * Include and exclude controls for one dimension, drawn as a single joined
 * control so the eye reads one dimension instead of two boxes. `stacked`
 * (the mobile drawer) splits it into two full-width fields instead.
 */
export function FilterPair({
  label,
  excludeLabel,
  include,
  exclude,
  stacked = false,
}: {
  label: string
  excludeLabel: string
  include: React.ReactNode
  exclude: React.ReactNode
  stacked?: boolean
}) {
  if (stacked) {
    return (
      <>
        <FilterField label={label}>{include}</FilterField>
        <FilterField label={excludeLabel}>{exclude}</FilterField>
      </>
    )
  }
  return (
    <div data-slot="filter-pair" className="flex min-w-0 flex-col gap-1">
      <span className={FIELD_LABEL}>{label}</span>
      <div
        className={cn(
          "flex items-stretch",
          "[&>[data-pair=start]_:is(input,button)]:rounded-r-none",
          "[&>[data-pair=end]]:-ml-px [&>[data-pair=end]_:is(input,button)]:rounded-l-none",
          "[&>*:focus-within]:relative [&>*:focus-within]:z-10",
        )}
      >
        <div data-pair="start" className="flex min-w-0">
          {include}
        </div>
        <div data-pair="end" className="flex min-w-0" aria-label={excludeLabel}>
          {exclude}
        </div>
      </div>
    </div>
  )
}

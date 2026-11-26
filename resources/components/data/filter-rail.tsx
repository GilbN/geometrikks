import { useId } from "react"
import { cn } from "@/lib/utils"

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

const FIELD_LABEL =
  "text-[10px] font-medium uppercase leading-4 tracking-[0.06em] text-muted-foreground"

/**
 * A labeled control, in the phone filter drawers and the Security filters. A
 * drawer's flex column stretches it to full width.
 * `hideLabel` is for controls that already name themselves, like a select
 * trigger, where a label would just repeat the button text; the label is
 * still the control's accessible name. `group` is for fields holding several
 * controls, like a radio list or a checklist. A `<label>` would forward a tap
 * on the caption to the first control, so these render a labelled group.
 */
export function FilterField({
  label,
  hideLabel = false,
  group = false,
  children,
  className,
}: {
  label: string
  hideLabel?: boolean
  group?: boolean
  children: React.ReactNode
  className?: string
}) {
  const captionId = useId()
  if (group) {
    return (
      <div
        data-slot="filter-field"
        role="group"
        aria-labelledby={captionId}
        className={cn("flex min-w-0 flex-col gap-1", className)}
      >
        <span id={captionId} className={cn(FIELD_LABEL, hideLabel && "sr-only")}>
          {label}
        </span>
        {children}
      </div>
    )
  }
  return (
    <label data-slot="filter-field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className={cn(FIELD_LABEL, hideLabel && "sr-only")}>{label}</span>
      {children}
    </label>
  )
}

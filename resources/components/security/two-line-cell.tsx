/**
 * The narrow-card row shared by Active decisions and Alert history: the
 * target and its status on the first line, the scenario and a time on the
 * second.
 */
import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { CountryFlag } from "@/components/country-flag"
import { TableCell } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export function ExpandChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn("mr-1 inline size-3.5 shrink-0 align-middle text-muted-foreground transition-transform", open && "rotate-90")}
    />
  )
}

/** Phone-row class for an IP or other target value, which wraps rather than
 *  truncates, so a long IPv6 address stays readable. */
export const ROW_TARGET_VALUE_CLASS = "min-w-0 whitespace-normal font-mono [overflow-wrap:anywhere]"

/** Lets a decision badge wrap inside a phone row, for a bouncer's own
 *  decision type that is longer than the row is wide. */
export const WRAPPING_BADGE_CLASS = "h-auto min-h-5 max-w-full whitespace-normal [overflow-wrap:anywhere]"

/**
 * The first line of a row with a target: expand chevron, flag, value and
 * actions, then the status at the right. When they don't fit on one line
 * the status moves below rather than squeezing the value, and a status
 * wider than the row wraps.
 */
export function RowTarget({
  open,
  countryCode,
  countryName,
  value,
  actions,
  status,
}: {
  /** Set on a row that expands, to draw its chevron. */
  open?: boolean
  countryCode: string | null | undefined
  countryName: string | null | undefined
  value: ReactNode
  actions?: ReactNode
  status: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {open !== undefined && <ExpandChevron open={open} />}
        <CountryFlag code={countryCode} name={countryName} standalone />
        {value}
        {actions}
      </span>
      <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">{status}</span>
    </div>
  )
}

export function TwoLineCell({
  top,
  bottom,
  bottomEnd,
  nested = false,
}: {
  top: ReactNode
  bottom: ReactNode
  /** Right-aligned on the second line, usually a time. */
  bottomEnd?: ReactNode
  /** A sub-row of an expanded group. */
  nested?: boolean
}) {
  return (
    <TableCell className={nested ? "py-2 pl-7" : "py-2.5"}>
      <div className="flex min-w-0 items-center gap-1.5">{top}</div>
      <div className={cn("flex min-w-0 items-center gap-2 text-xs", nested ? "mt-0.5" : "mt-1")}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{bottom}</span>
        {bottomEnd}
      </div>
    </TableCell>
  )
}

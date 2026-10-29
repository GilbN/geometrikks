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

/** The expand chevron, flag, value and actions that start the first line. */
export function RowTarget({
  open,
  countryCode,
  countryName,
  value,
  actions,
}: {
  /** Set on a row that expands, to draw its chevron. */
  open?: boolean
  countryCode: string | null | undefined
  countryName: string | null | undefined
  value: ReactNode
  actions?: ReactNode
}) {
  return (
    <>
      {open !== undefined && <ExpandChevron open={open} />}
      <CountryFlag code={countryCode} name={countryName} standalone />
      {value}
      {actions}
    </>
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

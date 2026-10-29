/**
 * Narrow layout for the ranked top lists: what is ranked on the left with its
 * count on the right, and the supporting numbers on a muted line below.
 */
import type { ReactNode } from "react"
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export function RankedNarrowHeader({ label, valueLabel }: { label: ReactNode; valueLabel: string }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">{label}</span>
            <span>{valueLabel}</span>
          </span>
        </TableHead>
      </TableRow>
    </TableHeader>
  )
}

export function RankedNarrowCell({
  primary,
  value,
  secondary,
  trailing,
}: {
  primary: ReactNode
  value: ReactNode
  secondary?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <TableCell className="py-2.5 whitespace-normal">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">{primary}</div>
        <span className="shrink-0 font-medium tabular-nums">{value}</span>
        {trailing}
      </div>
      {secondary && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {secondary}
        </div>
      )}
    </TableCell>
  )
}

import type { ReactNode } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"

import { TableHead } from "@/components/ui/table"
import { cn } from "@/lib/utils"

interface SortableHeadProps {
  label: ReactNode
  active: boolean
  sortOrder: "asc" | "desc"
  alignRight?: boolean
  onToggle: () => void
}

export function SortableHead({ label, active, sortOrder, alignRight = false, onToggle }: SortableHeadProps) {
  const ariaSort = active ? (sortOrder === "asc" ? "ascending" : "descending") : undefined
  return (
    <TableHead aria-sort={ariaSort} className={cn(alignRight && "text-right")}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground pointer-coarse:h-10 pointer-coarse:w-full",
          alignRight && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {active ? (
          sortOrder === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  )
}

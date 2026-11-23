/**
 * The header of a column that holds several sortable fields. The server sorts
 * by one field at a time, so a click sorts by the column's main field, its
 * first option, or flips the order of the one already active. The arrow
 * beside the label picks another field. The header names the active field.
 */
import { ArrowDown, ArrowUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { sortOrderLabel, type SortOption } from "@/components/data/sort-options"
import { cn } from "@/lib/utils"

export function CombinedSortHead<F extends string>({
  label,
  options,
  sortField,
  sortOrder,
  onSortChange,
}: {
  label: string
  /** The main field first. */
  options: readonly SortOption<F>[]
  sortField: F
  sortOrder: "asc" | "desc"
  onSortChange: (field: F, order: "asc" | "desc") => void
}) {
  const active = options.find((option) => option.field === sortField) ?? null
  const shown = active ?? options[0]
  const ariaSort = active ? (sortOrder === "asc" ? "ascending" : "descending") : undefined
  return (
    <TableHead aria-sort={ariaSort}>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() =>
            active
              ? onSortChange(active.field, sortOrder === "asc" ? "desc" : "asc")
              : onSortChange(options[0].field, "desc")
          }
          className={cn(
            "inline-flex items-center gap-1 uppercase hover:text-foreground",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
          {active && (
            <span className="font-medium normal-case tracking-normal text-muted-foreground">
              by {active.label.toLowerCase()}
            </span>
          )}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Sort ${label.toLowerCase()} by`}
              className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" collisionPadding={8} className="min-w-48">
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-[0.08em]">
              Sort {label.toLowerCase()} by
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={active?.field ?? ""}
              onValueChange={(value) => onSortChange(value as F, active ? sortOrder : "desc")}
            >
              {options.map((option) => (
                <DropdownMenuRadioItem key={option.field} value={option.field}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={active ? sortOrder : ""}
              onValueChange={(value) => onSortChange(shown.field, value as "asc" | "desc")}
            >
              {(["asc", "desc"] as const).map((order) => (
                <DropdownMenuRadioItem key={order} value={order}>
                  {order === "asc" ? <ArrowUp /> : <ArrowDown />}
                  {sortOrderLabel(shown.kind, order)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TableHead>
  )
}

/**
 * Sorting for a narrow table, which has no header row to click. The trigger
 * names the current sort, and the drawer lists the sortable fields and the order.
 */
import { ArrowDown, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { FilterField } from "@/components/data/filter-rail"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { sortOrderLabel, type SortOption } from "@/components/data/sort-options"

export function TableSortDrawer<F extends string>({
  options,
  sortField,
  sortOrder,
  onSortChange,
}: {
  options: readonly SortOption<F>[]
  sortField: F
  sortOrder: "asc" | "desc"
  onSortChange: (field: F, order: "asc" | "desc") => void
}) {
  const current = options.find((option) => option.field === sortField) ?? options[0]
  const orderLabel = sortOrderLabel(current.kind, sortOrder)
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline" size="sm" className="h-8" aria-label={`Sort by ${current.label}, ${orderLabel.toLowerCase()}`}>
          {sortOrder === "asc" ? <ArrowUp /> : <ArrowDown />}
          {current.label}
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Sort</DrawerTitle>
          <DrawerDescription className="sr-only">Choose the field and order the rows are sorted by.</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-6">
          <FilterField label="Order" group>
            <ToggleGroup
              type="single"
              variant="outline"
              value={sortOrder}
              onValueChange={(value) => value && onSortChange(current.field, value as "asc" | "desc")}
              className="w-full"
            >
              <ToggleGroupItem value="desc" className="flex-1">
                <ArrowDown />
                {sortOrderLabel(current.kind, "desc")}
              </ToggleGroupItem>
              <ToggleGroupItem value="asc" className="flex-1">
                <ArrowUp />
                {sortOrderLabel(current.kind, "asc")}
              </ToggleGroupItem>
            </ToggleGroup>
          </FilterField>
          <FilterField label="Sort by" group>
            <RadioGroup
              aria-label="Sort by"
              value={current.field}
              onValueChange={(value) => onSortChange(value as F, "desc")}
              className="gap-0"
            >
              {options.map((option) => (
                <label key={option.field} className="flex min-h-11 items-center gap-3 text-sm">
                  <RadioGroupItem value={option.field} />
                  {option.label}
                </label>
              ))}
            </RadioGroup>
          </FilterField>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * The phone IP actions drawer's filters: one row per value the page can
 * filter on, with Filter and Exclude beside it. A pressed button shows the
 * value is in that list. Pressing it again takes the value out, and pressing
 * the other one moves it across. Every press closes the drawer.
 */
import { Check, EyeOff, Filter } from "lucide-react"
import { DrawerClose } from "@/components/ui/drawer"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { FilterTarget } from "@/lib/ip-filter-targets"
import { cn } from "@/lib/utils"

const BUTTON = "h-11 w-22 gap-1.5 px-2 font-normal"

export function IpFilterToggles({
  heading,
  targets,
  onFilter,
}: {
  /** What the drawer already names; a target with this value shows no value line. */
  heading: string
  targets: FilterTarget[]
  onFilter?: () => void
}) {
  // A page with no exclude filters drops the column, rather than leaving
  // every row with a gap.
  const excludeColumn = targets.some((target) => target.exclude)
  return (
    <div className="flex flex-col">
      {targets.map((target) => (
        <FilterToggleRow
          key={`${target.noun}:${target.value}`}
          heading={heading}
          target={target}
          excludeColumn={excludeColumn}
          onFilter={onFilter}
        />
      ))}
    </div>
  )
}

function FilterToggleRow({
  heading,
  target,
  excludeColumn,
  onFilter,
}: {
  heading: string
  target: FilterTarget
  excludeColumn: boolean
  onFilter?: () => void
}) {
  const shown = target.value === heading ? null : target.value
  const detail = shown === null ? "" : ` ${shown}`
  const label = target.noun.charAt(0).toUpperCase() + target.noun.slice(1)
  const included = target.state === "include"
  const excluded = target.state === "exclude"
  const choose = (next: string) => {
    if (next === "include") target.include?.()
    else if (next === "exclude") target.exclude?.()
    else target.remove()
    onFilter?.()
  }
  return (
    <div className="flex min-h-12.5 items-center gap-2.5 pr-1 pl-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-tight">{label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={shown ?? undefined}>
          {shown ?? `this ${target.noun}`}
        </div>
      </div>
      <div className={cn("grid shrink-0", excludeColumn ? "grid-cols-[5.5rem_5.5rem]" : "grid-cols-[5.5rem]")}>
        <ToggleGroup
          type="single"
          variant="outline"
          value={target.state ?? ""}
          onValueChange={choose}
          aria-label={`${label}${detail}`}
          className={cn(target.include && target.exclude && "col-span-2", !target.include && "col-start-2")}
        >
          {target.include && (
            <DrawerClose asChild>
              <ToggleGroupItem
                value="include"
                aria-label={`Filter by ${target.noun}${detail}`}
                className={cn(BUTTON, "data-[state=on]:border-primary/40 data-[state=on]:bg-primary/15 data-[state=on]:text-primary")}
              >
                {included ? <Check /> : <Filter />}
                Filter
              </ToggleGroupItem>
            </DrawerClose>
          )}
          {target.exclude && (
            <DrawerClose asChild>
              <ToggleGroupItem
                value="exclude"
                aria-label={`Exclude ${target.noun}${detail}`}
                className={cn(BUTTON, "data-[state=on]:border-destructive/40 data-[state=on]:bg-destructive/15 data-[state=on]:text-destructive")}
              >
                {excluded ? <Check /> : <EyeOff />}
                Exclude
              </ToggleGroupItem>
            </DrawerClose>
          )}
        </ToggleGroup>
      </div>
    </div>
  )
}

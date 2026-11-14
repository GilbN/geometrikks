/**
 * Searchable, multi-select filter dropdown. A small trigger button (matching
 * the app's existing filter-bar buttons) opens either a floating combobox
 * popup with a search box (desktop) or a drawer with the same search +
 * checklist body (phones, touch-friendly; from the right held sideways).
 * A phone drawer that holds several filters uses FilterListRow instead.
 */
import { useState } from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { Check, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { SideDrawerClose } from "@/components/map/SideDrawer"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"
import { cn } from "@/lib/utils"

interface FilterComboboxProps<T extends string | number> {
  label: string
  options: T[]
  selected: T[]
  onChange: (values: T[]) => void
  /** Display text for an option; defaults to String(value). */
  labelFor?: (value: T) => string
  /** Leading icon for an option; search still matches labelFor only. */
  iconFor?: (value: T) => React.ReactNode
  /** Options are still being fetched (e.g. lazy-loaded facets). */
  loading?: boolean
  emptyText?: string
  className?: string
  contentClassName?: string
  /** Fired when the popup/drawer opens or closes (e.g. to lazy-load facets). */
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  /** Unpicked options turn inactive once this many are picked. */
  maxSelected?: number
}

export function FilterComboboxBody<T extends string | number>({
  options,
  selected,
  onChange,
  labelFor,
  iconFor,
  loading,
  emptyText,
  label,
  maxSelected,
  fill = false,
  splitLabel = false,
}: Pick<
  FilterComboboxProps<T>,
  "options" | "selected" | "onChange" | "labelFor" | "iconFor" | "loading" | "emptyText" | "label" | "maxSelected"
> & {
  labelFor: (value: T) => string
  /** Stretch the checklist to the height of the parent. */
  fill?: boolean
  /** Mute everything after a label's first word, such as an ASN's network name. */
  splitLabel?: boolean
}) {
  // ASN stays in capitals.
  const searchName = label === label.toUpperCase() ? label : label.toLowerCase()
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const filtered = options.filter((o) => labelFor(o).toLowerCase().includes(q))
  const ordered = [...filtered].sort(
    (a, b) => Number(selected.includes(b)) - Number(selected.includes(a)),
  )
  const toggle = (o: T) =>
    onChange(selected.includes(o) ? selected.filter((v) => v !== o) : [...selected, o])
  const atMax = maxSelected !== undefined && selected.length >= maxSelected

  return (
    <div className={cn("flex flex-col gap-1.5", fill && "min-h-0 flex-1")}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${searchName}`}
        aria-label={`Search ${searchName}`}
        autoComplete="off"
        // text-base (16px) keeps iOS Safari from zooming the page on focus.
        className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 text-base shadow-xs outline-none focus-visible:ring-[3px]"
      />
      <div className={cn("border-input overflow-y-auto overscroll-contain rounded-md border", fill ? "min-h-0 flex-1 divide-y divide-border/60" : "max-h-56")}>
        {loading ? (
          <div className="text-muted-foreground px-2.5 py-2 text-xs">Loading…</div>
        ) : ordered.length === 0 ? (
          <div className="text-muted-foreground px-2.5 py-2 text-xs">
            {emptyText ?? "No matches"}
          </div>
        ) : (
          ordered.map((o) => {
            const isSel = selected.includes(o)
            return (
              <button
                key={o}
                type="button"
                onClick={() => toggle(o)}
                aria-pressed={isSel}
                disabled={atMax && !isSel}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm disabled:opacity-50 pointer-coarse:min-h-10",
                  fill && "min-h-[46px] gap-3 px-3 text-[15px] pointer-coarse:min-h-[46px]",
                  isSel ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    isSel ? "bg-foreground border-foreground text-background" : "border-input",
                  )}
                >
                  {isSel && <Check className="h-3 w-3" />}
                </span>
                {iconFor?.(o)}
                <span className="truncate">
                  {splitLabel ? (
                    <>
                      {labelFor(o).split(" ")[0]}{" "}
                      <span className="text-muted-foreground">{labelFor(o).split(" ").slice(1).join(" ")}</span>
                    </>
                  ) : (
                    labelFor(o)
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>
      {atMax && <MaxSelectedNote maxSelected={maxSelected} />}
    </div>
  )
}

function MaxSelectedNote({ maxSelected }: { maxSelected: number }) {
  return <div className="text-muted-foreground px-2.5 py-1.5 text-xs">At most {maxSelected} at a time</div>
}

export function FilterCombobox<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  labelFor = (v) => String(v),
  iconFor,
  loading = false,
  emptyText,
  className,
  contentClassName,
  onOpenChange,
  disabled = false,
  maxSelected,
}: FilterComboboxProps<T>) {
  const [open, setOpen] = useState(false)
  const changeOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  const drawer = usePhoneDrawer("filter-combobox", open, () => changeOpen(false))
  const count = selected.length
  const atMax = maxSelected !== undefined && count >= maxSelected
  const triggerLabel = `${label}${count > 0 ? ` (${count})` : ""}`

  if (drawer.phone) {
    return (
      <Drawer key={drawer.key} direction={drawer.direction} open={drawer.open} onOpenChange={changeOpen} onClosed={drawer.onClosed}>
        <DrawerTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className={cn("h-8 pointer-coarse:h-10", count > 0 && "border-primary/60 text-primary", className)}>
            {triggerLabel}
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DrawerTrigger>
        <DrawerContent className={drawer.contentClassName}>
          <DrawerHeader className={drawer.side ? "flex-row items-center justify-between" : undefined}>
            <DrawerTitle>{label}</DrawerTitle>
            <DrawerDescription className="sr-only">
              Search and select {label.toLowerCase()} values to filter by.
            </DrawerDescription>
            {drawer.side && <SideDrawerClose />}
          </DrawerHeader>
          <div className={drawer.side ? "min-h-0 overflow-y-auto overscroll-contain px-4 pb-6" : "px-4 pb-6"}>
            <FilterComboboxBody
              options={options}
              selected={selected}
              onChange={onChange}
              labelFor={labelFor}
              iconFor={iconFor}
              loading={loading}
              emptyText={emptyText}
              label={label}
              maxSelected={maxSelected}
            />
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Combobox
      multiple
      items={options}
      value={selected}
      onValueChange={(value) => onChange(value as T[])}
      itemToStringLabel={labelFor}
      onOpenChange={changeOpen}
      disabled={disabled}
    >
      <ComboboxPrimitive.Trigger
        render={<Button variant="outline" size="sm" className={cn("h-8 pointer-coarse:h-10", count > 0 && "border-primary/60 text-primary", className)} />}
      >
        {triggerLabel}
        <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent className={cn("min-w-56", contentClassName)}>
        <ComboboxInput
          placeholder={`Search ${label.toLowerCase()}…`}
          showTrigger={false}
          className="text-xs"
        />
        <ComboboxList>
          {(item: T) => (
            <ComboboxItem key={item} value={item} disabled={atMax && !selected.includes(item)} className="text-xs">
              {iconFor?.(item)}
              {labelFor(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{loading ? "Loading…" : (emptyText ?? "No matches")}</ComboboxEmpty>
        {atMax && <MaxSelectedNote maxSelected={maxSelected} />}
      </ComboboxContent>
    </Combobox>
  )
}

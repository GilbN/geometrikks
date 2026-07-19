/**
 * Searchable, multi-select filter dropdown. A small trigger button (matching
 * the app's existing filter-bar buttons) opens either a floating combobox
 * popup with a search box (desktop) or a bottom drawer with the same search
 * + checklist body (mobile, touch-friendly). Pass `forceInline` when the
 * host already provides its own on-mobile overlay (e.g. a panel that's
 * itself a Drawer) so this component doesn't nest a second one.
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
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

interface FilterComboboxProps<T extends string | number> {
  label: string
  options: T[]
  selected: T[]
  onChange: (values: T[]) => void
  /** Display text for an option; defaults to String(value). */
  labelFor?: (value: T) => string
  /** Options are still being fetched (e.g. lazy-loaded facets). */
  loading?: boolean
  emptyText?: string
  className?: string
  contentClassName?: string
  /** Fired when the popup/drawer opens or closes (e.g. to lazy-load facets). */
  onOpenChange?: (open: boolean) => void
  /**
   * Render just the search + checklist body in place, with no trigger or
   * overlay. For hosts that already manage their own mobile overlay.
   */
  forceInline?: boolean
}

function FilterComboboxBody<T extends string | number>({
  options,
  selected,
  onChange,
  labelFor,
  loading,
  emptyText,
  label,
}: Pick<
  FilterComboboxProps<T>,
  "options" | "selected" | "onChange" | "labelFor" | "loading" | "emptyText" | "label"
> & { labelFor: (value: T) => string }) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const filtered = options.filter((o) => labelFor(o).toLowerCase().includes(q))
  const ordered = [...filtered].sort(
    (a, b) => Number(selected.includes(b)) - Number(selected.includes(a)),
  )
  const toggle = (o: T) =>
    onChange(selected.includes(o) ? selected.filter((v) => v !== o) : [...selected, o])

  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${label.toLowerCase()}`}
        aria-label={`Search ${label.toLowerCase()}`}
        autoComplete="off"
        // text-base (16px) keeps iOS Safari from zooming the page on focus.
        className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 text-base shadow-xs outline-none focus-visible:ring-[3px]"
      />
      <div className="border-input max-h-56 overflow-y-auto overscroll-contain rounded-md border">
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
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm",
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
                <span className="truncate">{labelFor(o)}</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export function FilterCombobox<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  labelFor = (v) => String(v),
  loading = false,
  emptyText,
  className,
  contentClassName,
  onOpenChange,
  forceInline = false,
}: FilterComboboxProps<T>) {
  const isMobile = useIsMobile()
  const count = selected.length
  const triggerLabel = `${label}${count > 0 ? ` (${count})` : ""}`

  if (forceInline) {
    return (
      <FilterComboboxBody
        options={options}
        selected={selected}
        onChange={onChange}
        labelFor={labelFor}
        loading={loading}
        emptyText={emptyText}
        label={label}
      />
    )
  }

  if (isMobile) {
    return (
      <Drawer onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 pointer-coarse:h-10", className)}>
            {triggerLabel}
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{label}</DrawerTitle>
            <DrawerDescription className="sr-only">
              Search and select {label.toLowerCase()} values to filter by.
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-6">
            <FilterComboboxBody
              options={options}
              selected={selected}
              onChange={onChange}
              labelFor={labelFor}
              loading={loading}
              emptyText={emptyText}
              label={label}
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
      onOpenChange={onOpenChange}
    >
      <ComboboxPrimitive.Trigger
        render={<Button variant="outline" size="sm" className={cn("h-8 pointer-coarse:h-10", className)} />}
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
            <ComboboxItem key={item} value={item} className="text-xs">
              {labelFor(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{loading ? "Loading…" : (emptyText ?? "No matches")}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

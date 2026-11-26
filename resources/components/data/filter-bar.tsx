/**
 * A page's filters on one line, for wide screens: the page's leading controls
 * (the Access Logs tabs), its search field, a chip per active filter and a
 * Filter menu that adds more. Clear, the Muted IPs button and the table's own
 * tools sit at the right. Chips wrap to more lines and all stay in view.
 *
 * The bar holds no filter state. Chips come from the fields the page passes,
 * so a filter set anywhere else (the palette, F on a row, a row's IP menu)
 * shows up as a chip. Only the open picker and a field picked but not yet
 * given a value live here.
 */
import { Fragment, useEffect, useId, useRef, useState } from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { Ban, ChevronDown, EyeOff, Eye, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Combobox, ComboboxContent } from "@/components/ui/combobox"
import { FilterComboboxOptions } from "@/components/ui/filter-combobox"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { FilterBarToolsSlot } from "@/components/data/filter-bar-slot"
import { AddFilterMenu, type FilterValueSearch } from "@/components/data/filter-bar-menu"
import {
  activeModes,
  chipId,
  chipValues,
  orderChips,
  parseChipId,
  switchMode,
  type FilterBarField,
  type FilterMode,
  type ListFilterBarField,
  type TypedFilterBarField,
} from "@/components/data/filter-bar-fields"
import type { MutedScope } from "@/lib/muted-ips"
import type { MyIpExclusion } from "@/lib/my-ip-exclusion"
import { useFilterPins } from "@/lib/table-view"
import { cn } from "@/lib/utils"

const CHIP =
  "inline-flex h-8 max-w-[26rem] min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-input/30 text-[13px] shadow-xs"
const CHIP_OPEN = "border-ring ring-3 ring-ring/50"
const CHIP_NOT = "border-destructive/50 text-destructive"

export function FilterBar({
  label,
  pageId,
  leading,
  search,
  fields,
  activeCount,
  onClear,
  myIp,
  muted,
  onToggleMuted,
  valueSearch,
}: {
  /** The bar's accessible name. */
  label: string
  /** Pins are kept per page under this id. */
  pageId: string
  leading?: React.ReactNode
  search: React.ReactNode
  fields: FilterBarField[]
  /** Filter groups set, the search included; Clear shows from two. */
  activeCount: number
  onClear: () => void
  myIp?: MyIpExclusion
  muted?: MutedScope
  onToggleMuted?: () => void
  valueSearch?: FilterValueSearch
}) {
  const [pins, togglePin] = useFilterPins(pageId)
  const [openId, setOpenId] = useState<string | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const byId = new Map(fields.map((field) => [field.id, field]))
  const pinned = pins.filter((id) => byId.has(id))

  const active = fields.flatMap((field) => activeModes(field).map((mode) => chipId(field.id, mode)))
  // Chips keep the order they arrived in. It lives in a ref because it follows
  // the filters in the same render, and computing it twice gives the same list.
  const order = useRef<string[]>([])
  order.current = orderChips(order.current, active)

  const open = openId === null ? null : parseChipId(openId)
  const isPinnedEmpty = (field: FilterBarField) =>
    pinned.includes(field.id) && activeModes(field).length === 0
  // A draft chip leaves with its picker, so its focus goes to the add button.
  const focusAdd = useRef(false)
  useEffect(() => {
    if (!focusAdd.current) return
    focusAdd.current = false
    addRef.current?.focus()
  })
  const closeIf = (id: string) => (next: boolean) => {
    if (next) return setOpenId(id)
    const field = byId.get(parseChipId(id).fieldId)
    if (field && !active.includes(id) && !isPinnedEmpty(field)) focusAdd.current = true
    setOpenId((current) => (current === id ? null : current))
  }
  const switchTo = (field: FilterBarField, from: FilterMode) => (to: FilterMode) => {
    if (to === from) return
    // An empty picker only changes mode; writing the same filters would still reset the page.
    if (chipValues(field, from).length > 0) {
      const values = switchMode<string | number>(field.include, field.exclude ?? [], to)
      ;(field.onChange as (include: unknown[], exclude: unknown[]) => void)(
        values.include,
        values.exclude,
      )
    }
    setOpenId(chipId(field.id, to))
  }
  const removeChip = (field: FilterBarField, mode: FilterMode) => {
    const onChange = field.onChange as (include: unknown[], exclude: unknown[]) => void
    if (mode === "is") onChange([], field.exclude ?? [])
    else onChange(field.include, [])
    setOpenId(null)
    addRef.current?.focus()
  }

  const chip = (field: FilterBarField, mode: FilterMode, slot: "value" | "pinned" | "draft") => {
    const id = chipId(field.id, mode)
    return (
      <FieldChip
        // One key per field and mode, so a chip that loses its last value keeps its open
        // picker. An empty pinned field keeps one key, so its is / is not switch keeps it mounted.
        key={slot === "pinned" ? `pin:${field.id}` : id}
        field={field}
        mode={mode}
        slot={slot}
        open={openId === id}
        onOpenChange={closeIf(id)}
        onModeChange={switchTo(field, mode)}
        onRemove={() => removeChip(field, mode)}
      />
    )
  }

  const items: React.ReactNode[] = []
  const shown = new Set<string>()
  for (const fieldId of pinned) {
    const field = byId.get(fieldId)!
    const modes = activeModes(field)
    for (const mode of modes) {
      items.push(chip(field, mode, "value"))
      shown.add(chipId(fieldId, mode))
    }
    // An empty pinned field opens its picker on the mode it was left on.
    if (modes.length === 0)
      items.push(chip(field, open?.fieldId === fieldId ? open.mode : "is", "pinned"))
  }
  for (const id of order.current) {
    if (shown.has(id)) continue
    const { fieldId, mode } = parseChipId(id)
    items.push(chip(byId.get(fieldId)!, mode, "value"))
  }
  // A field picked from the menu shows as a chip with its picker open until it gets a value.
  const draft = open && !active.includes(openId!) ? byId.get(open.fieldId) : undefined
  // An empty pinned field opens from its own button instead.
  if (draft && open && !isPinnedEmpty(draft)) items.push(chip(draft, open.mode, "draft"))

  const pickField = (fieldId: string) => {
    const field = byId.get(fieldId)
    if (!field) return
    const modes = activeModes(field)
    // A field with one chip gets a new chip for the other mode; its own chip reopens on a click.
    const mode: FilterMode =
      field.exclude && modes.length === 1 ? (modes[0] === "is" ? "not" : "is") : "is"
    setOpenId(chipId(fieldId, mode))
  }

  return (
    <div
      data-slot="filter-bar"
      role="region"
      aria-label={label}
      className="flex min-w-0 items-start gap-2"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {leading}
        {search}
        {items}
        <AddFilterMenu
          ref={addRef}
          compact={items.length > 0}
          fields={fields}
          pins={pinned}
          onTogglePin={togglePin}
          onPickField={pickField}
          myIp={myIp}
          muted={muted}
          onToggleMuted={onToggleMuted}
          valueSearch={valueSearch}
        />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2">
        {activeCount >= 2 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpenId(null)
              onClear()
            }}
            className="h-8 px-2 text-[13px] font-normal text-muted-foreground"
          >
            Clear
          </Button>
        )}
        {muted && onToggleMuted && <MutedIpsButton scope={muted} onToggle={onToggleMuted} />}
        <FilterBarToolsSlot />
      </div>
    </div>
  )
}

const HIDING =
  "border-primary/45 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary dark:border-primary/45 dark:bg-primary/10"

/** The Muted IPs switch at the right of the bar, while the list has entries. */
function MutedIpsButton({ scope, onToggle }: { scope: MutedScope; onToggle: () => void }) {
  const hintId = useId()
  if (scope.chip === "none") return null
  const hiding = scope.chip === "hiding"
  const greyed = scope.chip === "greyed"
  const title = greyed
    ? "Muted IPs: off while filtering by IP"
    : hiding
      ? "Muted IPs hidden"
      : "Muted IPs shown"
  // aria-disabled, not disabled, so the button keeps focus and its reason reaches a keyboard.
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Hide muted IPs"
        aria-pressed={greyed ? undefined : hiding}
        aria-disabled={greyed || undefined}
        aria-describedby={greyed ? hintId : undefined}
        title={title}
        onClick={greyed ? undefined : onToggle}
        className={cn(
          "h-8 gap-1.5 px-2.5 text-[13px] tabular-nums",
          hiding && HIDING,
          greyed && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
      >
        {scope.chip === "shown" ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        {scope.count}
      </Button>
      {greyed && (
        <span id={hintId} className="sr-only">
          Off while filtering by IP
        </span>
      )}
    </>
  )
}

/** Sets one mode's values. A value can't be in both lists, so the other mode drops it. */
function setModeValues(field: FilterBarField, mode: FilterMode, values: (string | number)[]) {
  const onChange = field.onChange as (include: unknown[], exclude: unknown[]) => void
  const without = (list: (string | number)[]) => list.filter((value) => !values.includes(value))
  if (mode === "is") onChange(values, without(field.exclude ?? []))
  else onChange(without(field.include), values)
}

interface ChipProps {
  field: FilterBarField
  mode: FilterMode
  /** A chip with values, an empty pinned field, or a field just picked from the menu. */
  slot: "value" | "pinned" | "draft"
  open: boolean
  onOpenChange: (open: boolean) => void
  onModeChange: (mode: FilterMode) => void
  onRemove: () => void
}

function FieldChip(props: ChipProps) {
  return props.field.picker === "list" ? (
    <ListChip {...props} field={props.field as unknown as ListFilterBarField<string | number>} />
  ) : (
    <TypedChip {...props} field={props.field} />
  )
}

/** The chip's face: the field, its values and an x. The trigger wraps the field and values. */
function ChipFace({
  field,
  mode,
  slot,
  open,
  anchorRef,
  trigger,
  onRemove,
}: Omit<ChipProps, "onOpenChange" | "onModeChange"> & {
  anchorRef: React.Ref<HTMLSpanElement>
  trigger: (props: {
    className: string
    children: React.ReactNode
    "aria-label": string
  }) => React.ReactNode
}) {
  const values = chipValues(field, mode)
  const not = mode === "not"
  const name = values.length > 0 ? (field.chipLabel ?? field.label) : field.label
  const max = field.chipValues ?? 2
  const shown = values.slice(0, max)
  const more = values.length - shown.length
  const labelFor = field.labelFor as (value: string | number) => string
  const chipValue = field.chipValue as ((value: string | number) => React.ReactNode) | undefined
  const spoken = `${field.label} ${not ? "is not" : "is"} ${values.map(labelFor).join(", ")}`
  return (
    <span
      ref={anchorRef}
      data-slot="filter-chip"
      data-field={field.id}
      data-mode={mode}
      className={cn(CHIP, not && CHIP_NOT, open && CHIP_OPEN)}
    >
      {trigger({
        "aria-label": slot === "value" ? spoken : `${field.label} filter`,
        className: cn(
          "flex min-w-0 items-center gap-1.5 pl-2.5 outline-none hover:bg-accent/50 focus-visible:bg-accent/60",
          slot === "value" ? "pr-2" : slot === "pinned" ? "pr-2" : "pr-2.5",
        ),
        children: (
          <>
            {not && <Ban aria-hidden className="size-3.5 shrink-0" />}
            <span
              className={cn(
                "shrink-0",
                slot === "value"
                  ? not
                    ? "text-destructive"
                    : "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {name}
            </span>
            {slot === "value" && (
              <span
                className={cn(
                  "flex min-w-0 items-center overflow-hidden font-medium whitespace-pre",
                  field.mono && "font-mono text-xs",
                  not ? "text-destructive" : "text-foreground",
                )}
              >
                {shown.map((value, index) => (
                  <Fragment key={String(value)}>
                    {index > 0 && (
                      <span className="shrink-0 font-normal text-muted-foreground">, </span>
                    )}
                    <span className="min-w-0 truncate [&>img]:mr-1.5 [&>img]:align-[-1px]">
                      {chipValue ? chipValue(value) : labelFor(value)}
                    </span>
                  </Fragment>
                ))}
                {more > 0 && (
                  <span className="shrink-0 font-sans font-normal text-muted-foreground">
                    {" "}
                    +{more}
                  </span>
                )}
              </span>
            )}
            {slot === "pinned" && (
              <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        ),
      })}
      {slot === "value" && (
        <button
          type="button"
          aria-label={`Remove ${field.label} ${not ? "is not" : "is"} filter`}
          onClick={onRemove}
          className={cn(
            "grid w-[26px] shrink-0 place-items-center border-l text-muted-foreground outline-none hover:text-foreground focus-visible:bg-accent/60",
            not ? "border-destructive/35 hover:text-destructive" : "border-input",
          )}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </span>
  )
}

/** The picker's first line: the field and, where it can exclude, the is / is not switch. */
function PickerHeader({
  field,
  mode,
  onModeChange,
}: {
  field: FilterBarField
  mode: FilterMode
  onModeChange: (mode: FilterMode) => void
}) {
  if (!field.exclude) return null
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-2.5">
      <span className="text-[13px] font-semibold">{field.label}</span>
      <ToggleGroup
        type="single"
        size="sm"
        value={mode}
        onValueChange={(value) => value && onModeChange(value as FilterMode)}
        aria-label={`${field.label} is or is not`}
        className="rounded-md bg-muted p-0.5"
      >
        <ToggleGroupItem
          value="is"
          className="h-[22px] min-w-0 px-2 text-xs data-[state=on]:bg-background"
        >
          is
        </ToggleGroupItem>
        <ToggleGroupItem
          value="not"
          className="h-[22px] min-w-0 px-2 text-xs data-[state=on]:bg-background data-[state=on]:text-destructive"
        >
          is not
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

function ListChip(
  props: Omit<ChipProps, "field"> & { field: ListFilterBarField<string | number> },
) {
  const { field, mode, open, onOpenChange, onModeChange } = props
  const anchorRef = useRef<HTMLSpanElement>(null)
  const selected = chipValues(field, mode)
  // Values set elsewhere, such as an excluded host from a row's menu, stay listed.
  const [query, setQuery] = useState("")
  const labelFor = field.labelFor as (value: string | number) => string
  // A value whose name or code is exactly what was typed comes first: "no" finds Norway (NO).
  const exact = (value: string | number) => {
    const q = query.trim().toLowerCase()
    const label = labelFor(value).toLowerCase()
    return q !== "" && (label === q || label.endsWith(`(${q})`))
  }
  const options = [
    ...field.options,
    ...selected.filter((value) => !field.options.includes(value)),
  ].sort((a, b) => Number(exact(b)) - Number(exact(a)))
  const setSelected = (values: (string | number)[]) =>
    setModeValues(field as FilterBarField, mode, values)
  useEffect(() => {
    if (!open) setQuery("")
  }, [open])
  useEffect(() => {
    if (open) field.onOpen?.()
    // Only the opening matters; a new onOpen each render must not refire it.
  }, [open])
  return (
    <Combobox
      multiple
      items={options}
      value={selected}
      onValueChange={(value) => setSelected(value as (string | number)[])}
      itemToStringLabel={field.labelFor as (value: string | number) => string}
      open={open}
      onOpenChange={onOpenChange}
      onInputValueChange={setQuery}
      autoHighlight
    >
      <ChipFace
        {...props}
        anchorRef={anchorRef}
        trigger={({ className, children, "aria-label": ariaLabel }) => (
          <ComboboxPrimitive.Trigger
            aria-label={ariaLabel}
            render={<button type="button" className={className} />}
          >
            {children}
          </ComboboxPrimitive.Trigger>
        )}
      />
      <ComboboxContent anchor={anchorRef} className="w-64 min-w-64">
        <PickerHeader field={field} mode={mode} onModeChange={onModeChange} />
        <FilterComboboxOptions
          label={field.label}
          selected={selected}
          labelFor={field.labelFor as (value: string | number) => string}
          iconFor={field.iconFor as ((value: string | number) => React.ReactNode) | undefined}
          loading={field.loading}
          emptyText={field.emptyText}
          textClassName="text-sm"
        />
      </ComboboxContent>
    </Combobox>
  )
}

function TypedChip(props: Omit<ChipProps, "field"> & { field: TypedFilterBarField }) {
  const { field, mode, open, onOpenChange, onModeChange } = props
  const anchorRef = useRef<HTMLSpanElement>(null)
  const hintId = useId()
  const [draft, setDraft] = useState("")
  const values = chipValues(field, mode) as string[]
  const value = draft.trim()
  const invalid = value !== "" && !field.validate(value)
  const hintText = invalid && field.hint ? field.hint(value) : null
  const setValues = (next: string[]) => setModeValues(field, mode, next)
  // The bar can close the picker itself, as Clear does, without onOpenChange.
  useEffect(() => {
    if (!open) setDraft("")
  }, [open])
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef} />
      <ChipFace
        {...props}
        anchorRef={anchorRef}
        trigger={({ className, children, "aria-label": ariaLabel }) => (
          <PopoverTrigger asChild>
            <button type="button" aria-label={ariaLabel} className={className}>
              {children}
            </button>
          </PopoverTrigger>
        )}
      />
      <PopoverContent align="start" sideOffset={6} className="w-[22rem] gap-0 p-0">
        <PickerHeader field={field} mode={mode} onModeChange={onModeChange} />
        <div className="px-1 pt-1 pb-1">
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              if (!value || invalid) return
              if (!values.includes(value)) setValues([...values, value])
              setDraft("")
            }}
            placeholder={field.placeholder}
            aria-label={`${field.label} ${mode === "not" ? "is not" : "is"}`}
            aria-invalid={invalid}
            aria-describedby={hintText ? hintId : undefined}
            className="h-9 font-mono text-[13px]"
          />
          {hintText && (
            <p id={hintId} className="mt-1 px-1 font-mono text-[11px] break-all text-destructive">
              {hintText}
            </p>
          )}
        </div>
        {values.length > 0 && (
          <ul className="max-h-40 overflow-y-auto px-1 pb-1" aria-label={`${field.label} values`}>
            {values.map((entry) => (
              <li
                key={entry}
                className="flex h-7 items-center justify-between gap-2 rounded-sm pr-1 pl-2 font-mono text-[13px] hover:bg-accent/50"
              >
                <span className="truncate">{entry}</span>
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  onClick={() => setValues(values.filter((v) => v !== entry))}
                  className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="flex items-start gap-2 border-t px-2.5 py-2 text-xs text-muted-foreground">
          <Kbd className="border bg-transparent">Enter</Kbd>
          <span>adds it. {field.help}</span>
        </p>
      </PopoverContent>
    </Popover>
  )
}

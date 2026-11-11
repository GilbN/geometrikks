/**
 * The phone Filters drawer's list rows. A short list opens the system's
 * multi-select; a long one opens a search page inside the drawer.
 */
import { createPortal } from "react-dom"
import { useId, type ReactNode } from "react"
import { Check, ChevronRight, ChevronsUpDown, X } from "lucide-react"
import { UNTRUSTED_PROXY_HINT } from "@/components/data/exclude-my-ip"
import { TagInput } from "@/components/data/tag-input"
import { FilterComboboxBody } from "@/components/ui/filter-combobox"
import { useFilterPages } from "@/components/ui/filters-drawer"
import type { MyIpExclusion } from "@/lib/my-ip-exclusion"
import { cn } from "@/lib/utils"

const ROW = "flex h-11 items-center justify-between gap-3 px-3 text-[15px] not-first:border-t not-first:border-border/60"

export function FilterSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="mt-1">
      {label && <div className="mb-1.5 px-0.5 text-xs uppercase tracking-[0.08em] text-muted-foreground">{label}</div>}
      <div className="overflow-hidden rounded-xl border border-border bg-control">{children}</div>
    </div>
  )
}

function RowValue({ text, tone, icon }: { text: string; tone?: "include" | "exclude"; icon: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <span
        className={cn(
          "max-w-[190px] truncate",
          tone === "include" && "text-primary",
          tone === "exclude" && "text-destructive",
        )}
      >
        {text}
      </span>
      {icon}
    </span>
  )
}

let multiSelectIsOneLine: boolean | undefined

/**
 * Phones draw a multi-select as one line that opens the system's list. Desktop
 * engines draw an inline list box, and this row's invisible select would then
 * pick whichever option is under the finger. Device emulation reports a coarse
 * pointer and still draws the list box, so measure the control.
 */
function opensSystemList() {
  if (multiSelectIsOneLine === undefined) {
    const probe = document.createElement("div")
    probe.style.cssText = "position: absolute; visibility: hidden"
    probe.innerHTML = "<select multiple><option></option></select><select><option></option></select>"
    document.body.append(probe)
    const [multiple, single] = probe.querySelectorAll("select")
    multiSelectIsOneLine = multiple.offsetHeight <= single.offsetHeight
    probe.remove()
  }
  return multiSelectIsOneLine
}

interface FilterListRowProps<T extends string | number> {
  label: string
  options: T[]
  selected: T[]
  onChange: (values: T[]) => void
  /** Text in the list; defaults to String(value). */
  labelFor?: (value: T) => string
  /** Text in the row, where the list's longer label would not fit. */
  valueFor?: (value: T) => string
  iconFor?: (value: T) => ReactNode
  /** Open a search page instead of the system's list, which has no search box. */
  search?: boolean
  /** Mute everything after a label's first word on the search page. */
  splitLabel?: boolean
  exclude?: boolean
  loading?: boolean
  disabled?: boolean
  emptyText?: string
  maxSelected?: number
  onOpen?: () => void
}

export function FilterListRow<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  labelFor = String,
  valueFor = labelFor,
  iconFor,
  search = false,
  splitLabel = false,
  exclude = false,
  loading = false,
  disabled = false,
  emptyText,
  maxSelected,
  onOpen,
}: FilterListRowProps<T>) {
  const id = useId()
  const pages = useFilterPages()
  const name = exclude ? `Exclude ${label}` : label
  const empty = loading ? "Loading…" : exclude ? "None" : "Any"
  const text = selected.length === 0 ? empty : `${valueFor(selected[0])}${selected.length > 1 ? ` +${selected.length - 1}` : ""}`
  const tone = selected.length === 0 ? undefined : exclude ? "exclude" : "include"
  const iconClass = "size-3.5 shrink-0"

  if (!search && opensSystemList()) {
    // A value set from elsewhere, such as an IP's menu, may not be in this range's facets.
    const all = [...options, ...selected.filter((value) => !options.includes(value))]
    const atMax = maxSelected !== undefined && selected.length >= maxSelected
    return (
      <label className={cn(ROW, "relative")}>
        <span>{label}</span>
        <RowValue text={text} tone={tone} icon={<ChevronsUpDown aria-hidden className={iconClass} />} />
        <select
          multiple
          aria-label={name}
          disabled={disabled || loading}
          value={selected.map(String)}
          onChange={(event) => {
            const chosen = new Set(Array.from(event.target.selectedOptions, (option) => option.value))
            onChange(all.filter((value) => chosen.has(String(value))))
          }}
          className="absolute inset-0 size-full opacity-0"
        >
          {all.map((value) => (
            <option key={value} value={String(value)} disabled={atMax && !selected.includes(value)}>
              {labelFor(value)}
            </option>
          ))}
        </select>
      </label>
    )
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={`${name}: ${text}`}
        onClick={() => {
          onOpen?.()
          pages?.open(id, name)
        }}
        className={cn(ROW, "w-full text-left disabled:opacity-50")}
      >
        <span>{label}</span>
        <RowValue text={text} tone={tone} icon={<ChevronRight aria-hidden className={iconClass} />} />
      </button>
      {pages?.activeId === id && pages.host && createPortal(
        <FilterComboboxBody
          fill
          splitLabel={splitLabel}
          label={label}
          options={options}
          selected={selected}
          onChange={onChange}
          labelFor={labelFor}
          iconFor={iconFor}
          loading={loading}
          emptyText={emptyText}
          maxSelected={maxSelected}
        />,
        pages.host,
      )}
    </>
  )
}

export function FilterMyIpRow({ exclusion }: { exclusion: MyIpExclusion }) {
  if (exclusion.behindUntrustedProxy) {
    return (
      <div className={ROW}>
        <span>Your IP</span>
        <span className="truncate text-xs text-muted-foreground">{UNTRUSTED_PROXY_HINT}</span>
      </div>
    )
  }
  if (exclusion.ip === null) return null
  return (
    <div className={ROW}>
      <span className="shrink-0">Your IP</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">{exclusion.ip}</span>
        <button
          type="button"
          aria-label="Exclude your IP"
          aria-pressed={exclusion.excluded}
          onClick={exclusion.toggle}
          className={cn(
            "grid h-8 shrink-0 place-items-center rounded-md text-xs font-medium",
            exclusion.excluded ? "-mr-3 size-11 text-primary" : "border border-destructive/50 px-2 text-destructive",
          )}
        >
          {exclusion.excluded ? <Check aria-hidden className="size-4" /> : "Exclude"}
        </button>
      </span>
    </div>
  )
}

/** Excluded IPs are typed, because an address may not be in any list. */
export function FilterExcludedIpRows({
  values,
  onAdd,
  onRemove,
  validate,
}: {
  values: string[]
  onAdd: (value: string) => void
  onRemove: (value: string) => void
  validate: (value: string) => boolean
}) {
  return (
    <>
      {values.map((value) => (
        <div key={value} className={ROW}>
          <span>IP</span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-sm text-destructive">
            <span className="truncate">{value}</span>
            <button
              type="button"
              aria-label={`Remove exclusion ${value}`}
              onClick={() => onRemove(value)}
              className="-mr-3 grid size-11 shrink-0 place-items-center text-muted-foreground"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </span>
        </div>
      ))}
      <div className={ROW}>
        <span>IP</span>
        <TagInput
          onAdd={onAdd}
          validate={validate}
          placeholder={values.length > 0 ? "Add" : "None"}
          aria-label="Exclude IP"
          className="min-w-0 flex-1"
          inputClassName="h-10 border-0 bg-transparent pl-0 pr-5 text-right shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
    </>
  )
}

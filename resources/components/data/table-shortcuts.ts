/**
 * What the table shortcuts act on. A virtual table marks its <table> with
 * `data-shortcut-table` and registers a lookup of its rows' values here; cells a
 * page can filter on carry `data-filter-noun`, matching a FilterTarget noun.
 */
import type { FilterTarget, IpRowValues } from "@/lib/ip-filter-targets"

export interface RowShortcutData {
  values: IpRowValues
  targetsFor: ((values: IpRowValues) => FilterTarget[]) | null
}

const bodies = new WeakMap<Element, (index: number) => RowShortcutData | undefined>()

export function registerShortcutBody(
  body: Element,
  lookup: (index: number) => RowShortcutData | undefined,
): void {
  bodies.set(body, lookup)
}

export function shortcutRowData(row: HTMLTableRowElement): RowShortcutData | undefined {
  const body = row.closest("tbody")
  return body ? bodies.get(body)?.(Number(row.dataset.index)) : undefined
}

const ROW = "tr[data-index]"
const TABLE = "[data-shortcut-table]"

function isShown(element: Element): boolean {
  return element.getClientRects().length > 0
}

/** The row with keyboard focus, when focus is on a row or inside one. */
export function focusedRow(): HTMLTableRowElement | null {
  const active = document.activeElement
  if (!(active instanceof Element)) return null
  const row = active.closest<HTMLTableRowElement>(ROW)
  return row?.closest(TABLE) ? row : null
}

let pointer: { x: number; y: number } | null = null

/** Follows the mouse, so F and the row keys can act on what it points at. */
export function trackPointer(): () => void {
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "mouse") pointer = { x: event.clientX, y: event.clientY }
  }
  const onLeave = () => {
    pointer = null
  }
  window.addEventListener("pointermove", onMove, { passive: true })
  document.documentElement.addEventListener("pointerleave", onLeave)
  return () => {
    window.removeEventListener("pointermove", onMove)
    document.documentElement.removeEventListener("pointerleave", onLeave)
  }
}

function elementUnderPointer(): Element | null {
  return pointer ? document.elementFromPoint(pointer.x, pointer.y) : null
}

function hoveredRow(): HTMLTableRowElement | null {
  const row = elementUnderPointer()?.closest<HTMLTableRowElement>(ROW) ?? null
  return row?.closest(TABLE) ? row : null
}

/** The row a row shortcut acts on: the focused one, else the one under the mouse. */
export function targetRow(): HTMLTableRowElement | null {
  return focusedRow() ?? hoveredRow()
}

/** The cell under the mouse that a page can filter on, with the row it sits in. */
export function filterCellUnderPointer(): { row: HTMLTableRowElement; noun: string } | null {
  const element = elementUnderPointer()
  const row = element?.closest<HTMLTableRowElement>(ROW)
  if (!element || !row?.closest(TABLE)) return null
  const cell = element.closest<HTMLElement>("[data-filter-noun]")
  if (!cell?.dataset.filterNoun || !row.contains(cell)) return null
  return { row, noun: cell.dataset.filterNoun }
}

/** The table J and K move through: the one holding focus, else the first one shown. */
function activeTable(): Element | null {
  const fromFocus = document.activeElement?.closest(TABLE)
  if (fromFocus) return fromFocus
  return [...document.querySelectorAll(TABLE)].find(isShown) ?? null
}

function focusRow(row: HTMLTableRowElement): void {
  row.focus({ preventScroll: true })
  row.scrollIntoView({ block: "nearest" })
}

/** The first row that shows below the table's header, so J starts where the eye is. */
function firstVisibleRow(table: Element): HTMLTableRowElement | null {
  const rows = [...table.querySelectorAll<HTMLTableRowElement>(ROW)]
  const header = table.querySelector("thead")?.getBoundingClientRect().bottom ?? 0
  const box = table.parentElement?.getBoundingClientRect()
  const top = Math.max(header, box?.top ?? 0, 0)
  return rows.find((row) => row.getBoundingClientRect().bottom > top + 1) ?? rows[0] ?? null
}

/**
 * Moves focus one row down or up. The virtual table keeps the focused row's
 * neighbours mounted, so the next row is always in the DOM.
 */
export function moveRow(step: 1 | -1): boolean {
  const current = focusedRow()
  if (!current) {
    const table = activeTable()
    const first = table ? firstVisibleRow(table) : null
    if (!first) return false
    focusRow(first)
    return true
  }
  const table = current.closest(TABLE)
  const index = Number(current.dataset.index) + step
  const next = table?.querySelector<HTMLTableRowElement>(`${ROW}[data-index="${index}"]`)
  if (!next) return false
  focusRow(next)
  return true
}

/**
 * Turns the page of the table that holds focus, then focuses the first row
 * of the new page once its rows have loaded. The old rows stay on screen
 * while the new page loads, so this waits for the footer to show the new
 * page with nothing pending. It gives up if focus moves elsewhere meanwhile.
 */
export function stepPage(step: 1 | -1): boolean {
  const row = focusedRow()
  const frame = row?.closest('[data-slot="data-table-frame"]')
  const footer = frame?.querySelector<HTMLElement>("[data-pagination]")
  const button = footer?.querySelector<HTMLButtonElement>(
    `[data-page-step="${step === 1 ? "next" : "previous"}"]`,
  )
  if (!frame || !footer || !button || button.disabled) return false
  const target = String(Number(footer.dataset.page) + step)
  button.click()
  const startedAt = Date.now()
  const settle = () => {
    const active = document.activeElement
    if (!frame.isConnected) return
    if (active && active !== document.body && !row?.contains(active)) return
    const current = frame.querySelector<HTMLElement>("[data-pagination]")
    if (current?.dataset.page === target && current.dataset.pending === undefined) {
      const table = frame.querySelector(TABLE)
      const first = table ? firstVisibleRow(table) : null
      if (first) {
        focusRow(first)
        return
      }
    }
    if (Date.now() - startedAt < 5000) window.setTimeout(settle, 50)
  }
  window.setTimeout(settle, 50)
  return true
}

/**
 * Focuses the page's main filter field, marked `data-page-filter`. A page
 * whose filter bar has no search field marks its Filter button, which opens.
 */
export function focusPageFilter(): boolean {
  const field = [...document.querySelectorAll<HTMLElement>("[data-page-filter]")].find(isShown)
  if (!field) return false
  field.focus()
  if (field instanceof HTMLInputElement) field.select()
  if (field instanceof HTMLButtonElement) field.click()
  return true
}

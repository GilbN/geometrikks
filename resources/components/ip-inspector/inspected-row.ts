/**
 * The log table row whose IP the inspector shows. The docked inspector marks
 * that row and steps from it to the next row with another IP, across pages.
 * Rows are held by key, so the mark stays on its row when live tail adds rows
 * above it.
 */
import { targetRow } from "@/components/data/table-shortcuts"
import { OUTSIDE_PAGE } from "./inspector-dock"

type RowKey = string | number

/** What a virtual table body tells the inspector about its rows. */
export interface RowList {
  count: () => number
  ipAt: (index: number) => string | undefined
  keyAt: (index: number) => RowKey | undefined
  indexOfKey: (key: RowKey) => number
  /** Scrolls the row into view, and focuses it when asked, once it renders. */
  reveal: (index: number, focus: boolean) => void
}

export interface InspectedRow {
  body: Element
  key: RowKey
  ip: string
}

const lists = new WeakMap<Element, RowList>()

export function registerRowList(body: Element, list: RowList): void {
  lists.set(body, list)
}

let inspected: InspectedRow | null = null
let markShown = false
let stepping = false
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

export function subscribeInspectedRow(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Changes whenever the row, the mark or a table's rows change. */
export function inspectedRowVersion(): number {
  return version
}

export function getInspectedRow(): InspectedRow | null {
  return inspected
}

export function setInspectedRow(next: InspectedRow | null): void {
  if (next === inspected) return
  inspected = next
  emit()
}

/** The mark shows only while the inspector is docked beside the table. */
export function setInspectedRowMarkShown(shown: boolean): void {
  if (shown === markShown) return
  markShown = shown
  emit()
}

/** A table body calls this when its rows change, so the arrows re-check what is left. */
export function notifyRowsChanged(): void {
  emit()
}

/** The key of the row a body should mark, if any. */
export function markedKeyFor(body: Element | null): RowKey | null {
  return markShown && body && inspected?.body === body ? inspected.key : null
}

let lastRow: HTMLTableRowElement | null = null

/**
 * Remembers the table row the user last clicked or focused on the page. Row
 * menus and the record sheet sit in portals, so a pick there leaves the row
 * it came from in place.
 */
export function trackRowInteraction(): () => void {
  const note = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element) || target.closest(OUTSIDE_PAGE)) return
    lastRow = target.closest<HTMLTableRowElement>("[data-shortcut-table] tr[data-index]")
  }
  document.addEventListener("pointerdown", note, true)
  document.addEventListener("focusin", note, true)
  return () => {
    document.removeEventListener("pointerdown", note, true)
    document.removeEventListener("focusin", note, true)
    lastRow = null
  }
}

/** The row an IP was just opened from: the last row used, or the one I acted on. */
export function claimInspectedRow(ip: string): InspectedRow | null {
  for (const row of [lastRow, targetRow()]) {
    const body = row?.isConnected ? row.closest("tbody") : null
    const list = body ? lists.get(body) : undefined
    if (!row || !body || !list) continue
    const index = Number(row.dataset.index)
    const key = list.keyAt(index)
    if (key === undefined || list.ipAt(index) !== ip) continue
    return { body, key, ip }
  }
  return null
}

function liveList(row: InspectedRow | null): RowList | undefined {
  return row?.body.isConnected ? lists.get(row.body) : undefined
}

/** The next row from `start` on with an IP other than `ip`, or -1. */
function findOtherIp(list: RowList, start: number, step: 1 | -1, ip: string): number {
  for (let index = start; index >= 0 && index < list.count(); index += step) {
    const other = list.ipAt(index)
    if (other !== undefined && other !== ip) return index
  }
  return -1
}

const FRAME = '[data-slot="data-table-frame"]'

function pageButton(body: Element, step: 1 | -1): HTMLButtonElement | null {
  const button = body
    .closest(FRAME)
    ?.querySelector<HTMLButtonElement>(
      `[data-pagination] [data-page-step="${step === 1 ? "next" : "previous"}"]`,
    )
  return button && !button.disabled ? button : null
}

/** The inspected row is on screen in a table, so the arrows apply. They stay
 *  while a step loads another page, so a focused arrow keeps focus. */
export function inspectedRowInTable(): boolean {
  if (stepping) return true
  const list = liveList(inspected)
  return !!inspected && !!list && list.indexOfKey(inspected.key) !== -1
}

/** A step this way finds another IP on this page, or there is a page to load. */
export function canStepInspectedRow(step: 1 | -1): boolean {
  if (stepping) return false
  const list = liveList(inspected)
  if (!inspected || !list) return false
  const index = list.indexOfKey(inspected.key)
  if (index === -1) return false
  return (
    findOtherIp(list, index + step, step, inspected.ip) !== -1 || !!pageButton(inspected.body, step)
  )
}

function land(
  body: Element,
  list: RowList,
  index: number,
  focus: boolean,
  inspect: (ip: string) => void,
) {
  const ip = list.ipAt(index)
  const key = list.keyAt(index)
  if (ip === undefined || key === undefined) return
  // Set first, so the inspector sees its new IP came from this row.
  setInspectedRow({ body, key, ip })
  list.reveal(index, focus)
  inspect(ip)
}

function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const check = () => {
      if (done()) resolve(true)
      else if (Date.now() - startedAt > timeoutMs) resolve(false)
      else window.setTimeout(check, 50)
    }
    window.setTimeout(check, 50)
  })
}

/**
 * Moves the inspector to the next row with another IP, loading the next or
 * previous page when this one has none. Focus follows to the row only when
 * it was on a row. Returns false when the inspector has no row to step from.
 */
export function stepInspectedRow(step: 1 | -1, inspect: (ip: string) => void): boolean {
  const from = inspected
  const list = liveList(from)
  if (!from || !list) return false
  const start = list.indexOfKey(from.key)
  if (start === -1) return false
  if (stepping) return true
  const focus = document.activeElement?.closest("tr[data-index]")?.closest("tbody") === from.body

  const index = findOtherIp(list, start + step, step, from.ip)
  if (index !== -1) {
    land(from.body, list, index, focus, inspect)
    return true
  }

  const button = pageButton(from.body, step)
  const frame = from.body.closest(FRAME)
  const footer = frame?.querySelector<HTMLElement>("[data-pagination]")
  if (!button || !frame || !footer) return true
  const page = String(Number(footer.dataset.page) + step)
  stepping = true
  emit()
  button.click()
  void waitFor(() => {
    const current = frame.querySelector<HTMLElement>("[data-pagination]")
    return current?.dataset.page === page && current.dataset.pending === undefined
  }, 10_000).then((loaded) => {
    stepping = false
    // Closed, or moved to another IP, while the page loaded.
    if (!loaded || inspected !== from || !frame.isConnected) return emit()
    const body = frame.querySelector("[data-shortcut-table] tbody")
    const next = body ? lists.get(body) : undefined
    if (!body || !next) return emit()
    const first = findOtherIp(next, step === 1 ? 0 : next.count() - 1, step, from.ip)
    if (first === -1) return emit()
    land(body, next, first, focus, inspect)
  })
  return true
}

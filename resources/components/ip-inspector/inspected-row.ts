/**
 * The log table row whose IP the inspector shows. The docked inspector marks
 * that row and steps from it to the next row with another IP, across pages.
 * Rows are held by key, so the mark stays on its row when a refresh adds rows
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
  /** The table's frame, to find the body again when the table remounts it. */
  frame: Element | null
  key: RowKey
  ip: string
}

const FRAME = '[data-slot="data-table-frame"]'

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

/**
 * A table body calls this when its rows change or it goes away, so the arrows
 * re-check what is left. A table that swaps its body, as it does when it turns
 * narrow, hands the mark to the new body.
 */
export function notifyRowsChanged(body?: Element): void {
  if (
    body &&
    inspected &&
    !inspected.body.isConnected &&
    inspected.frame !== null &&
    body.closest(FRAME) === inspected.frame &&
    (lists.get(body)?.indexOfKey(inspected.key) ?? -1) !== -1
  ) {
    inspected = { ...inspected, body }
  }
  emit()
}

/** The marked row's element, while it is rendered. */
export function inspectedRowElement(): HTMLElement | null {
  const list = liveList(inspected)
  const index = inspected && list ? list.indexOfKey(inspected.key) : -1
  return index === -1
    ? null
    : (inspected?.body.querySelector<HTMLElement>(`tr[data-index="${index}"]`) ?? null)
}

/** The key of the row a body should mark, if any. */
export function markedKeyFor(body: Element | null): RowKey | null {
  return markShown && body && inspected?.body === body ? inspected.key : null
}

let lastRow: HTMLTableRowElement | null = null
// The IP a step is opening, so its own navigation does not claim a row.
let steppedTo: string | null = null
// Counts what the user does on the page, so a step that waits for a page
// can tell they moved on meanwhile.
let pageInteractions = 0

/**
 * Remembers the table row the user last clicked or focused on the page. Row
 * menus and the record sheet sit in portals, so a pick there leaves the row
 * it came from in place.
 */
export function trackRowInteraction(): () => void {
  const note = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element) || target.closest(OUTSIDE_PAGE)) return
    pageInteractions++
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

/**
 * Called each time the inspector opens or changes IP. Takes the row the IP
 * was opened from: the row the I key acted on, else the last row used.
 * Without one, keeps the current row if it still shows this IP. The last row
 * is used up here, so a later step does not jump back to it.
 */
export function claimInspectedRow(ip: string): void {
  const used = lastRow
  lastRow = null
  const stepped = steppedTo === ip
  steppedTo = null
  if (stepped) return
  for (const row of [targetRow(), used]) {
    const body = row?.isConnected ? row.closest("tbody") : null
    const list = body ? lists.get(body) : undefined
    if (!row || !body || !list) continue
    const index = Number(row.dataset.index)
    const key = list.keyAt(index)
    if (key === undefined || list.ipAt(index) !== ip) continue
    if (inspected?.body !== body || inspected.key !== key)
      setInspectedRow({ body, frame: body.closest(FRAME), key, ip })
    return
  }
  if (inspected?.ip !== ip) setInspectedRow(null)
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
  setInspectedRow({ body, frame: body.closest(FRAME), key, ip })
  list.reveal(index, focus)
  steppedTo = ip
  inspect(ip)
}

/** Polls until `check` returns true (done) or false (give up). */
function poll(check: () => boolean | null, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const result = check()
      if (result !== null) resolve(result)
      else if (Date.now() - startedAt > timeoutMs) resolve(false)
      else window.setTimeout(tick, 50)
    }
    window.setTimeout(tick, 50)
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

  const frame = from.body.closest(FRAME)
  if (!frame || !pageButton(from.body, step)) return true
  stepping = true
  emit()
  void stepAcrossPages(from, frame, step, focus, inspect).finally(() => {
    stepping = false
    emit()
  })
  return true
}

/** Turns pages until one has another IP, as long as the user does nothing else. */
async function stepAcrossPages(
  from: InspectedRow,
  frame: Element,
  step: 1 | -1,
  focus: boolean,
  inspect: (ip: string) => void,
): Promise<void> {
  const interactions = pageInteractions
  for (;;) {
    const footer = frame.querySelector<HTMLElement>("[data-pagination]")
    const button = footer?.querySelector<HTMLButtonElement>(
      `[data-page-step="${step === 1 ? "next" : "previous"}"]`,
    )
    if (!footer || !button || button.disabled) return
    const before = footer.dataset.page
    const page = String(Number(before) + step)
    button.click()
    const loaded = await poll(() => {
      // Closed, moved to another IP, or the user went on with the page meanwhile.
      const current = frame.querySelector<HTMLElement>("[data-pagination]")
      if (inspected?.key !== from.key || inspected.ip !== from.ip) return false
      if (!frame.isConnected || pageInteractions !== interactions || !current) return false
      if (current.dataset.page !== page && current.dataset.page !== before) return false
      return current.dataset.page === page && current.dataset.pending === undefined ? true : null
    }, 10_000)
    if (!loaded) return
    const body = frame.querySelector("[data-shortcut-table] tbody")
    const list = body ? lists.get(body) : undefined
    if (!body || !list) return
    const index = findOtherIp(list, step === 1 ? 0 : list.count() - 1, step, from.ip)
    if (index !== -1) {
      // Clear the flag first, or the arrows re-read it as still loading.
      stepping = false
      land(body, list, index, focus, inspect)
      return
    }
  }
}

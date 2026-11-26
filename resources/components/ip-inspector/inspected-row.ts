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
  /** Scrolls the row into view, and focuses it when asked, once it renders.
   *  Takes the key, since a refresh can add rows above it before it renders. */
  reveal: (key: RowKey, focus: boolean) => void
}

export interface InspectedRow {
  body: Element
  /** The table's frame, to find the body again when the table remounts it. */
  frame: Element | null
  key: RowKey
  ip: string
}

const FRAME = '[data-slot="data-table-frame"]'

/** The first row from `start` on, going `step`, whose IP is `ip`, or -1. */
function findIp(list: RowList, start: number, step: 1 | -1, ip: string): number {
  for (let index = start; index >= 0 && index < list.count(); index += step) {
    if (list.ipAt(index) === ip) return index
  }
  return -1
}
// A step gives up on finding another IP after this many pages, so one IP
// filling the whole result does not turn every page.
const MAX_PAGES_PER_STEP = 5

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
  // The table left the page, such as for Live tail or another page.
  if (inspected?.frame && !inspected.frame.isConnected && !inspected.body.isConnected) {
    inspected = null
  } else if (
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

/** The frame of the table the inspected row is in. */
export function inspectedRowFrame(): Element | null {
  return inspected?.frame ?? null
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
// The IP the last step opened. Its URL can commit after a newer step's.
let landedIp: string | null = null
// Counts what the user does anywhere but the step arrows, so a step that
// waits for a page can tell they moved on meanwhile, such as to the dock's
// range picker.
let pageInteractions = 0

/**
 * Remembers the table row the user last clicked or focused on the page. Row
 * menus and the record sheet sit in portals, so a pick there leaves the row
 * it came from in place.
 */
export function trackRowInteraction(): () => void {
  const note = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (!target.closest("[data-row-step]")) pageInteractions++
    if (target.closest(OUTSIDE_PAGE)) return
    lastRow = target.closest<HTMLTableRowElement>("[data-shortcut-table] tr[data-index]")
  }
  // Keys count too, such as F filtering Debug Logs, whose filters are not in
  // the URL. J, K and keys on the arrows are the step itself.
  const noteKey = (event: KeyboardEvent) => {
    const onArrow = event.target instanceof Element && event.target.closest("[data-row-step]")
    if (!onArrow && !/^[jk]$/i.test(event.key)) pageInteractions++
  }
  document.addEventListener("pointerdown", note, true)
  document.addEventListener("focusin", note, true)
  document.addEventListener("keydown", noteKey, true)
  return () => {
    document.removeEventListener("pointerdown", note, true)
    document.removeEventListener("focusin", note, true)
    document.removeEventListener("keydown", noteKey, true)
    lastRow = null
  }
}

/**
 * Called on every open. Takes the row the IP was opened from: the row the I
 * key acted on, else the last row used on the page. A record sheet keeps
 * that row, since it sits outside the page. Without one, the inspector has
 * no row. A step's own open keeps the row the step chose.
 */
export function claimInspectedRow(ip: string): void {
  const stepped = steppedTo === ip
  steppedTo = null
  if (stepped) return
  landedIp = null
  for (const row of [targetRow(), lastRow]) {
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
  setInspectedRow(null)
}

/** Back, Forward or a closed inspector: the row stays only while its IP shows. */
export function keepInspectedRowFor(ip: string | undefined): void {
  if (ip === undefined) landedIp = null
  if (inspected && inspected.ip !== ip && inspected.ip !== landedIp) setInspectedRow(null)
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
  list.reveal(key, focus)
  steppedTo = ip
  landedIp = ip
  inspect(ip)
}

/** The URL's filters, without the page number and the inspected IP. */
function searchWithoutPage(): string {
  const params = new URLSearchParams(window.location.search)
  params.delete("page")
  params.delete("inspect")
  params.sort()
  return params.toString()
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
  // A held key repeats while a page loads, and the row it left is gone by then.
  if (stepping) return true
  const from = inspected
  const list = liveList(from)
  if (!from || !list) return false
  const start = list.indexOfKey(from.key)
  if (start === -1) return false
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
  const query = searchWithoutPage()
  let reached: { body: Element; list: RowList } | null = null
  for (let turns = 0; ; turns++) {
    const footer = frame.querySelector<HTMLElement>("[data-pagination]")
    const button = footer?.querySelector<HTMLButtonElement>(
      `[data-page-step="${step === 1 ? "next" : "previous"}"]`,
    )
    if (!footer || !button || button.disabled || turns === MAX_PAGES_PER_STEP) {
      // The pages turned hold only the IP shown. Mark the last row reached, so
      // the arrows stay and lead on or back.
      if (reached) {
        // The far end can be a line with no IP, as on Debug Logs.
        const index = findIp(
          reached.list,
          step === 1 ? reached.list.count() - 1 : 0,
          step === 1 ? -1 : 1,
          from.ip,
        )
        const key = index === -1 ? undefined : reached.list.keyAt(index)
        if (key === undefined) return
        stepping = false
        setInspectedRow({ body: reached.body, frame, key, ip: from.ip })
        reached.list.reveal(key, focus)
      }
      return
    }
    const before = footer.dataset.page
    const page = String(Number(before) + step)
    // A clamp can turn the page and back between two polls, so watch it turn.
    let turned = false
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.oldValue === page)) turned = true
    })
    observer.observe(frame, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-page"],
      attributeOldValue: true,
    })
    button.click()
    // Only the user or the table ends the wait. A slow query does not.
    const loaded = await poll(() => {
      // Closed, undocked, moved to another IP, or the user went on with the page meanwhile.
      const current = frame.querySelector<HTMLElement>("[data-pagination]")
      if (!markShown || inspected?.key !== from.key || inspected.ip !== from.ip) return false
      if (!frame.isConnected || pageInteractions !== interactions || !current) return false
      // A filter set from the keyboard also turns the page.
      if (searchWithoutPage() !== query) return false
      if (current.dataset.page !== page && current.dataset.page !== before) return false
      // Back where it started after turning: the page was clamped or reset.
      if (current.dataset.page === page) turned = true
      else if (turned) return false
      return current.dataset.page === page && current.dataset.pending === undefined ? true : null
    }, 60_000)
    observer.disconnect()
    if (!loaded) return
    const body = frame.querySelector("[data-shortcut-table] tbody")
    const list = body ? lists.get(body) : undefined
    if (!body || !list) return
    reached = { body, list }
    const index = findOtherIp(list, step === 1 ? 0 : list.count() - 1, step, from.ip)
    if (index !== -1) {
      // Clear the flag first, or the arrows re-read it as still loading.
      stepping = false
      land(body, list, index, focus, inspect)
      return
    }
  }
}

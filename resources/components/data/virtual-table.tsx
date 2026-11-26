import {
  cloneElement,
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
} from "react"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import { Table, TableBody } from "@/components/ui/table"
import type { RowDensity } from "@/lib/table-view"
import type { IpRowValues } from "@/lib/ip-filter-targets"
import { useIpFilterTargetsFor } from "@/components/ip-actions/ip-actions-menu"
import { registerShortcutBody, type RowShortcutData } from "@/components/data/table-shortcuts"
import {
  markedKeyFor,
  notifyRowsChanged,
  registerRowList,
  subscribeInspectedRow,
  type RowList,
} from "@/components/ip-inspector/inspected-row"

const HEADER_HEIGHT = 40
const ScrollContext = createContext<{
  scrollElement: HTMLDivElement | null
  resetKey: string
  narrow: boolean
  density: RowDensity
} | null>(null)

/** A compact row is 31 px with a badge or a 24 px IP control in it, a comfortable one 41 px. */
const ROW_ESTIMATE: Record<RowDensity, number> = { comfortable: 48, compact: 32 }

/**
 * Short fields take their natural width; text columns share the remaining space.
 * A narrow table has one cell per row and no header, and scrolls with the page
 * instead of in a box of its own. Density applies to the wide layout only.
 * Narrow rows are for touch and keep their height.
 */
export function VirtualTable({
  columns,
  rowCount,
  resetKey,
  narrow = false,
  density = "comfortable",
  children,
  ...props
}: ComponentProps<"table"> & {
  columns: readonly { key: string; grow?: boolean; width?: string }[]
  rowCount: number
  resetKey: string
  narrow?: boolean
  density?: RowDensity
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  // A narrow table reserves its rows' height in the commit that mounts it, and
  // Chrome would anchor <main>'s scroll on the content below and push a
  // scrolled page down. Set here, not in an effect: the ref attaches before
  // anything in that commit forces a layout.
  const attachScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      setScrollElement(element)
      const main = narrow ? element?.closest("main") : null
      if (!main) return
      const previousAnchor = main.style.overflowAnchor
      main.style.overflowAnchor = "none"
      return () => {
        main.style.overflowAnchor = previousAnchor
        setScrollElement(null)
      }
    },
    [narrow],
  )
  const context = useMemo(
    () => ({ scrollElement, resetKey, narrow, density }),
    [scrollElement, resetKey, narrow, density],
  )
  return (
    <ScrollContext.Provider value={context}>
      <Table
        {...props}
        containerRef={attachScrollElement}
        containerClassName={
          narrow ? "overflow-visible" : "max-h-[65dvh] overflow-auto overscroll-x-contain"
        }
        className={cn(
          // The row the docked inspector shows.
          "[&_tbody_tr[data-inspected]]:bg-primary/10 [&_tbody_tr[data-inspected]>td:first-child]:shadow-[inset_2px_0_0_var(--color-primary)]",
          narrow
            ? "table-fixed"
            : cn(
                "table-auto [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card",
                density === "compact" && "[&_tbody_td]:py-[3px]",
                // Rows that J and K scroll to stay clear of the sticky header.
                "[&_tbody_tr]:scroll-mt-10",
              ),
        )}
        data-density={narrow ? undefined : density}
        data-shortcut-table=""
        aria-rowcount={narrow ? rowCount : rowCount + 1}
      >
        {narrow ? (
          <colgroup>
            <col />
          </colgroup>
        ) : (
          <colgroup>
            {/* In auto layout, 1% keeps short fields at their content width.
                Unconstrained text columns get the remaining space. */}
            {columns.map((column) => (
              <col
                key={column.key}
                style={{ width: column.width ?? (column.grow ? undefined : "1%") }}
              />
            ))}
          </colgroup>
        )}
        {children}
      </Table>
    </ScrollContext.Provider>
  )
}

/**
 * Measure rows because IP controls and touch targets can change their height.
 * Give it a key that changes with the table's `narrow` prop, because the
 * virtualizer carries its scroll offset across a change of scroll element.
 */
export function VirtualTableBody<T>({
  rows,
  columnCount,
  getRowKey,
  onAwayFromTopChange,
  shortcutValues,
  children,
}: {
  rows: readonly T[]
  columnCount: number
  getRowKey: (row: T) => string | number
  /** Called when the scroll moves more than a row past the top of the list,
   *  and back. A list that grows at the top can hold new rows meanwhile. */
  onAwayFromTopChange?: (away: boolean) => void
  /** The row's IP and the values its cells filter on, for the I, C and F shortcuts. */
  shortcutValues?: (row: T) => IpRowValues | null
  children: (row: T) => ReactElement<ComponentProps<"tr">>
}) {
  const context = useContext(ScrollContext)
  if (!context) throw new Error("VirtualTableBody requires VirtualTable")
  const { scrollElement, resetKey, narrow, density } = context
  const targetsFor = useIpFilterTargetsFor()
  const headerHeight = narrow ? 0 : HEADER_HEIGHT
  const rowEstimate = narrow ? 76 : ROW_ESTIMATE[density]
  // A narrow table scrolls with the page, so the virtualizer follows <main>
  // and needs the table's offset inside it.
  const pageScroller = useMemo(
    () => (narrow ? (scrollElement?.closest<HTMLElement>("main") ?? null) : null),
    [narrow, scrollElement],
  )
  const [scrollMargin, setScrollMargin] = useState(0)
  const scrollMarginRef = useRef(0)
  const pageScrollerRef = useRef(pageScroller)
  pageScrollerRef.current = pageScroller
  useLayoutEffect(() => {
    if (!pageScroller || !scrollElement) return
    const measure = () => {
      const offset =
        scrollElement.getBoundingClientRect().top -
        pageScroller.getBoundingClientRect().top +
        pageScroller.scrollTop
      scrollMarginRef.current = Math.round(offset)
      setScrollMargin(scrollMarginRef.current)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pageScroller.firstElementChild ?? pageScroller)
    return () => observer.disconnect()
  }, [pageScroller, scrollElement])
  const margin = pageScroller ? scrollMargin : 0
  // By key, not index: rows that arrive at the top move the focused row down.
  const [focusedKey, setFocusedKey] = useState<string | number | null>(null)
  const focusedIndex = useMemo(() => {
    if (focusedKey === null) return null
    const index = rows.findIndex((row) => getRowKey(row) === focusedKey)
    return index === -1 ? null : index
  }, [focusedKey, rows, getRowKey])
  const getItemKey = useCallback((index: number) => getRowKey(rows[index]), [getRowKey, rows])
  // Null until the first report, so a fresh body says where it is even when
  // that is the top; the one it replaced may have last said "away".
  const awayFromTopRef = useRef<boolean | null>(null)
  const onAwayFromTopChangeRef = useRef(onAwayFromTopChange)
  onAwayFromTopChangeRef.current = onAwayFromTopChange
  useEffect(
    () => () => {
      if (awayFromTopRef.current) onAwayFromTopChangeRef.current?.(false)
    },
    [],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => pageScroller ?? scrollElement,
    // Wait for the scroller, then start from where it already is. A virtualizer
    // that renders first caches offset 0 and writes it into <main> on attach,
    // which jumps a scrolled page to the top when rows arrive.
    enabled: (pageScroller ?? scrollElement) !== null,
    initialOffset: () => (pageScroller ?? scrollElement)?.scrollTop ?? 0,
    getItemKey,
    estimateSize: () => rowEstimate,
    overscan: 15,
    scrollMargin: margin,
    onChange: (instance) => {
      if (!onAwayFromTopChangeRef.current) return
      const away = (instance.scrollOffset ?? 0) - scrollMarginRef.current > rowEstimate
      if (away !== awayFromTopRef.current) {
        awayFromTopRef.current = away
        onAwayFromTopChangeRef.current(away)
      }
    },
    paddingStart: headerHeight,
    scrollPaddingStart: headerHeight,
    // Keep the focused row and its neighbours mounted so Tab can cross the
    // rendered window, and a sheet can return focus to its original row.
    rangeExtractor: useCallback(
      (range) => {
        const indexes = defaultRangeExtractor(range)
        if (focusedIndex === null) return indexes
        for (let index = focusedIndex - 1; index <= focusedIndex + 1; index++) {
          if (index >= 0 && index < range.count) indexes.push(index)
        }
        return [...new Set(indexes)].sort((a, b) => a - b)
      },
      [focusedIndex],
    ),
  })

  // Rows measured at the other density would keep their old height until they
  // scroll into view again. Narrow rows ignore density.
  const measuredDensity = useRef(density)
  useLayoutEffect(() => {
    if (measuredDensity.current === density) return
    measuredDensity.current = density
    if (!narrow) virtualizer.measure()
  }, [density, narrow, virtualizer])

  useLayoutEffect(() => {
    setFocusedKey(null)
    // A scroll queued before the virtualizer has its element would land as 0
    // on whatever it attaches to.
    if (!virtualizer.scrollElement) return
    const pageScrollerNow = pageScrollerRef.current
    if (!pageScrollerNow) {
      virtualizer.scrollToOffset(0)
    } else {
      // Back to the first row, but leave a page that hasn't reached the table where it is.
      // The bars stuck to <main>'s top publish their heights there in px.
      const style = getComputedStyle(pageScrollerNow)
      const stuckAbove = ["--sticky-top", "--table-header-height"].reduce(
        (total, name) => total + (parseFloat(style.getPropertyValue(name)) || 0),
        0,
      )
      const firstRowTop = scrollMarginRef.current - stuckAbove
      if (pageScrollerNow.scrollTop > firstRowTop) pageScrollerNow.scrollTo({ top: firstRowTop })
    }
  }, [resetKey, virtualizer])

  // One lookup per body, read when a shortcut fires, so rows keep a stable ref.
  const shortcutLookup = useRef<(index: number) => RowShortcutData | undefined>(() => undefined)
  useLayoutEffect(() => {
    shortcutLookup.current = (index) => {
      const values =
        shortcutValues && rows[index] !== undefined ? shortcutValues(rows[index]) : null
      return values ? { values, targetsFor } : undefined
    }
  }, [shortcutValues, rows, targetsFor])
  // The rows the docked inspector marks and steps through.
  const rowList = useRef<RowList | null>(null)
  const [body, setBody] = useState<HTMLTableSectionElement | null>(null)
  useLayoutEffect(() => {
    if (!shortcutValues) return
    rowList.current = {
      count: () => rows.length,
      ipAt: (index) => (rows[index] === undefined ? undefined : shortcutValues(rows[index])?.ip),
      keyAt: (index) => (rows[index] === undefined ? undefined : getRowKey(rows[index])),
      indexOfKey: (key) => rows.findIndex((row) => getRowKey(row) === key),
      reveal: (index, focus) => {
        virtualizer.scrollToIndex(index, { align: "auto" })
        let frames = 0
        const settle = () => {
          const row = body?.querySelector<HTMLElement>(`tr[data-index="${index}"]`)
          if (!row) {
            if (++frames < 10) requestAnimationFrame(settle)
            return
          }
          if (focus) row.focus({ preventScroll: true })
          // The page around the table may need to scroll too.
          row.scrollIntoView({ block: "nearest" })
        }
        requestAnimationFrame(settle)
      },
    }
    notifyRowsChanged()
  }, [shortcutValues, rows, getRowKey, virtualizer, body])
  const markedKey = useSyncExternalStore(subscribeInspectedRow, () => markedKeyFor(body))

  const registerBody = useCallback((element: HTMLTableSectionElement | null) => {
    setBody(element)
    if (!element) return
    registerShortcutBody(element, (index) => shortcutLookup.current(index))
    registerRowList(element, {
      count: () => rowList.current?.count() ?? 0,
      ipAt: (index) => rowList.current?.ipAt(index),
      keyAt: (index) => rowList.current?.keyAt(index),
      indexOfKey: (key) => rowList.current?.indexOfKey(key) ?? -1,
      reveal: (index, focus) => rowList.current?.reveal(index, focus),
    })
  }, [])

  const items = virtualizer.getVirtualItems()
  // Until the virtualizer has its scroller there are no items. Reserve the
  // estimated height so the page doesn't shrink and drop its scroll position.
  const totalSize =
    items.length > 0 ? virtualizer.getTotalSize() : headerHeight + rows.length * rowEstimate
  const spacer = (height: number, key: string) =>
    height > 0 ? (
      <tr key={key} aria-hidden="true" role="presentation">
        <td colSpan={columnCount} style={{ height, padding: 0, border: 0 }} />
      </tr>
    ) : null

  return (
    <TableBody
      ref={registerBody}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-index]")
        if (row) setFocusedKey(getRowKey(rows[Number(row.dataset.index)]))
      }}
    >
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {spacer(
            item.start - (items[index - 1]?.end ?? margin + headerHeight),
            `before-${item.key}`,
          )}
          {cloneElement(children(rows[item.index]), {
            ref: virtualizer.measureElement,
            "data-index": item.index,
            "aria-rowindex": item.index + (narrow ? 1 : 2),
            role: "row",
            ...(markedKey !== null && getRowKey(rows[item.index]) === markedKey
              ? { "data-inspected": "", "aria-current": "true" }
              : {}),
          } as ComponentProps<"tr">)}
        </Fragment>
      ))}
      {spacer(totalSize + margin - (items.at(-1)?.end ?? margin + headerHeight), "after")}
    </TableBody>
  )
}

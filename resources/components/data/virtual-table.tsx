import {
  cloneElement, createContext, Fragment, useCallback, useContext, useLayoutEffect,
  useMemo, useRef, useState, type ComponentProps, type ReactElement,
} from "react"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { Table, TableBody } from "@/components/ui/table"

const HEADER_HEIGHT = 40
const ScrollContext = createContext<{
  scrollElement: HTMLDivElement | null
  resetKey: string
  narrow: boolean
} | null>(null)

/**
 * Short fields take their natural width; text columns share the remaining space.
 * A narrow table has one cell per row and no header, and scrolls with the page
 * instead of in a box of its own.
 */
export function VirtualTable({
  columns, rowCount, resetKey, narrow = false, children, ...props
}: ComponentProps<"table"> & {
  columns: readonly { key: string; grow?: boolean }[]
  rowCount: number
  resetKey: string
  narrow?: boolean
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const context = useMemo(() => ({ scrollElement, resetKey, narrow }), [scrollElement, resetKey, narrow])
  return (
    <ScrollContext.Provider value={context}>
      <Table
        {...props}
        containerRef={setScrollElement}
        containerClassName={narrow ? "overflow-visible" : "max-h-[65dvh] overflow-auto overscroll-x-contain"}
        className={narrow ? "table-fixed" : "table-auto [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card"}
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
            {columns.map((column) => <col key={column.key} style={{ width: column.grow ? undefined : "1%" }} />)}
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
export function VirtualTableBody<T>({ rows, columnCount, getRowKey, children }: {
  rows: readonly T[]
  columnCount: number
  getRowKey: (row: T) => string | number
  children: (row: T) => ReactElement<ComponentProps<"tr">>
}) {
  const context = useContext(ScrollContext)
  if (!context) throw new Error("VirtualTableBody requires VirtualTable")
  const { scrollElement, resetKey, narrow } = context
  const headerHeight = narrow ? 0 : HEADER_HEIGHT
  const rowEstimate = narrow ? 76 : 48
  // A narrow table scrolls with the page, so the virtualizer follows <main>
  // and needs the table's offset inside it.
  const pageScroller = useMemo(
    () => (narrow ? scrollElement?.closest<HTMLElement>("main") ?? null : null),
    [narrow, scrollElement],
  )
  const [scrollMargin, setScrollMargin] = useState(0)
  const scrollMarginRef = useRef(0)
  const pageScrollerRef = useRef(pageScroller)
  pageScrollerRef.current = pageScroller
  useLayoutEffect(() => {
    if (!pageScroller || !scrollElement) return
    const measure = () => {
      const offset = scrollElement.getBoundingClientRect().top - pageScroller.getBoundingClientRect().top + pageScroller.scrollTop
      scrollMarginRef.current = Math.round(offset)
      setScrollMargin(scrollMarginRef.current)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pageScroller.firstElementChild ?? pageScroller)
    return () => observer.disconnect()
  }, [pageScroller, scrollElement])
  const margin = pageScroller ? scrollMargin : 0
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const getItemKey = useCallback((index: number) => getRowKey(rows[index]), [getRowKey, rows])
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
    paddingStart: headerHeight,
    scrollPaddingStart: headerHeight,
    // Keep the focused row and its neighbours mounted so Tab can cross the
    // rendered window, and a sheet can return focus to its original row.
    rangeExtractor: useCallback((range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedIndex === null) return indexes
      for (let index = focusedIndex - 1; index <= focusedIndex + 1; index++) {
        if (index >= 0 && index < range.count) indexes.push(index)
      }
      return [...new Set(indexes)].sort((a, b) => a - b)
    }, [focusedIndex]),
  })

  useLayoutEffect(() => {
    setFocusedIndex(null)
    // A scroll queued before the virtualizer has its element would land as 0
    // on whatever it attaches to.
    if (!virtualizer.scrollElement) return
    const pageScrollerNow = pageScrollerRef.current
    if (!pageScrollerNow) {
      virtualizer.scrollToOffset(0)
    } else if (pageScrollerNow.scrollTop > scrollMarginRef.current) {
      // Back to the first row, but leave a page that hasn't reached the table where it is.
      pageScrollerNow.scrollTo({ top: scrollMarginRef.current })
    }
  }, [resetKey, virtualizer])

  const items = virtualizer.getVirtualItems()
  // Until the virtualizer has its scroller there are no items. Reserve the
  // estimated height so the page doesn't shrink and drop its scroll position.
  const totalSize = items.length > 0 ? virtualizer.getTotalSize() : headerHeight + rows.length * rowEstimate
  const spacer = (height: number, key: string) => height > 0 ? (
    <tr key={key} aria-hidden="true" role="presentation">
      <td colSpan={columnCount} style={{ height, padding: 0, border: 0 }} />
    </tr>
  ) : null

  return (
    <TableBody
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-index]")
        if (row) setFocusedIndex(Number(row.dataset.index))
      }}
    >
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {spacer(item.start - (items[index - 1]?.end ?? margin + headerHeight), `before-${item.key}`)}
          {cloneElement(children(rows[item.index]), {
            ref: virtualizer.measureElement,
            "data-index": item.index,
            "aria-rowindex": item.index + (narrow ? 1 : 2),
            role: "row",
          } as ComponentProps<"tr">)}
        </Fragment>
      ))}
      {spacer(totalSize + margin - (items.at(-1)?.end ?? margin + headerHeight), "after")}
    </TableBody>
  )
}

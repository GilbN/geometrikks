import {
  cloneElement, createContext, Fragment, useCallback, useContext, useLayoutEffect,
  useMemo, useState, type ComponentProps, type ReactElement,
} from "react"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { Table, TableBody } from "@/components/ui/table"

const HEADER_HEIGHT = 40
const ScrollContext = createContext<{
  scrollElement: HTMLDivElement | null
  resetKey: string
} | null>(null)

/** Short fields take their natural width; text columns share the remaining space. */
export function VirtualTable({
  columns, rowCount, resetKey, children, ...props
}: ComponentProps<"table"> & {
  columns: readonly { key: string; grow?: boolean }[]
  rowCount: number
  resetKey: string
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const context = useMemo(() => ({ scrollElement, resetKey }), [scrollElement, resetKey])
  return (
    <ScrollContext.Provider value={context}>
      <Table
        {...props}
        containerRef={setScrollElement}
        containerClassName="max-h-[65dvh] overflow-auto overscroll-x-contain"
        className="table-auto [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card"
        aria-rowcount={rowCount + 1}
      >
        <colgroup>
          {/* In auto layout, 1% keeps short fields at their content width.
              Unconstrained text columns get the remaining space. */}
          {columns.map((column) => <col key={column.key} style={{ width: column.grow ? undefined : "1%" }} />)}
        </colgroup>
        {children}
      </Table>
    </ScrollContext.Provider>
  )
}

/** Measure rows because IP controls and touch targets can change their height. */
export function VirtualTableBody<T>({ rows, columnCount, getRowKey, children }: {
  rows: readonly T[]
  columnCount: number
  getRowKey: (row: T) => string | number
  children: (row: T) => ReactElement<ComponentProps<"tr">>
}) {
  const context = useContext(ScrollContext)
  if (!context) throw new Error("VirtualTableBody requires VirtualTable")
  const { scrollElement, resetKey } = context
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const getItemKey = useCallback((index: number) => getRowKey(rows[index]), [getRowKey, rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    getItemKey,
    estimateSize: () => 48,
    overscan: 15,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
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
    virtualizer.scrollToOffset(0)
  }, [resetKey, virtualizer])

  const items = virtualizer.getVirtualItems()
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
          {spacer(item.start - (items[index - 1]?.end ?? HEADER_HEIGHT), `before-${item.key}`)}
          {cloneElement(children(rows[item.index]), {
            ref: virtualizer.measureElement,
            "data-index": item.index,
            "aria-rowindex": item.index + 2,
            role: "row",
          } as ComponentProps<"tr">)}
        </Fragment>
      ))}
      {spacer(virtualizer.getTotalSize() - (items.at(-1)?.end ?? HEADER_HEIGHT), "after")}
    </TableBody>
  )
}

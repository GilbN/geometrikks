import { useLayoutEffect, useRef, useState } from "react"

/** The card width below which a table switches to two-line rows, the same
 *  50rem the scheduler's task list uses. */
export const NARROW_TABLE_WIDTH = 800

/**
 * Tracks whether an element is narrower than `breakpoint`. Measured in a
 * layout effect, so the first paint already uses the right layout.
 */
export function useNarrowLayout<T extends HTMLElement>(
  breakpoint: number = NARROW_TABLE_WIDTH,
): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    if (!element) return
    const update = () => setNarrow(element.clientWidth < breakpoint)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, breakpoint])
  return [setElement, narrow]
}

/**
 * Narrow only when the element's full table doesn't fit. It renders the table,
 * and if the table overflows its box before paint, it records the width the
 * table needed and switches to narrow until the element is that wide again.
 * For tables whose columns, not a fixed breakpoint, decide when they fit.
 * When `contentKey` changes the full table gets another try, since new rows
 * can fit where the old ones did not. Build the key from which rows show, not
 * their figures: each try swaps the rows' components, which closes any menu
 * open in them, and a top list's counts change on nearly every poll.
 */
export function useFitLayout<T extends HTMLElement>(contentKey: string): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null)
  const [narrow, setNarrow] = useState(false)
  const neededWidth = useRef(0)
  const measuredKey = useRef(contentKey)

  // Runs after every render: the rows, and so the table's width, can change.
  useLayoutEffect(() => {
    if (measuredKey.current !== contentKey) {
      measuredKey.current = contentKey
      if (narrow) {
        setNarrow(false)
        return
      }
    }
    if (!element || narrow) return
    const table = element.querySelector("table")
    const box = table?.parentElement
    if (!table || !box) return
    if (box.scrollWidth > box.clientWidth + 1) {
      neededWidth.current = element.clientWidth + (box.scrollWidth - box.clientWidth)
      setNarrow(true)
    }
  })

  useLayoutEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (narrow && element.clientWidth >= neededWidth.current) setNarrow(false)
      else if (!narrow) {
        const box = element.querySelector("table")?.parentElement
        if (box && box.scrollWidth > box.clientWidth + 1) {
          neededWidth.current = element.clientWidth + (box.scrollWidth - box.clientWidth)
          setNarrow(true)
        }
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, narrow])

  return [setElement, narrow]
}

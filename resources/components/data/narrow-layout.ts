import { useLayoutEffect, useState } from "react"

/** The card width below which a table switches to two-line rows, the same
 *  50rem the scheduler's task list uses. */
export const NARROW_TABLE_WIDTH = 800

/**
 * Tracks whether an element is narrower than NARROW_TABLE_WIDTH. Measured in
 * a layout effect, so the first paint already uses the right layout.
 */
export function useNarrowLayout<T extends HTMLElement>(): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    if (!element) return
    const update = () => setNarrow(element.clientWidth < NARROW_TABLE_WIDTH)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, narrow]
}

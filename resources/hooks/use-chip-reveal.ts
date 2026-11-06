import { useEffect, useLayoutEffect, useState, type RefObject } from "react"

/** Matches the row's 48px fades and scroll-padding-inline. */
const CHIP_FADE_WIDTH = 48

function observeRowAndChips(observer: ResizeObserver, row: HTMLElement) {
  observer.observe(row)
  // Unseen dots arrive with their queries and widen chips without resizing the row.
  for (const child of row.children) observer.observe(child)
}

function reveal(row: HTMLElement, chip: Element) {
  const rowBox = row.getBoundingClientRect()
  const chipBox = chip.getBoundingClientRect()
  const start = chipBox.left - rowBox.left - CHIP_FADE_WIDTH
  const end = chipBox.right - rowBox.left - (row.clientWidth - CHIP_FADE_WIDTH)
  if (start < 0) row.scrollLeft += start
  else if (end > 0) row.scrollLeft += end
}

/**
 * Scrolls a chip row sideways so its current link, or a link that takes
 * keyboard focus, sits clear of the fades. It sets the row's scrollLeft
 * rather than calling scrollIntoView, which would scroll the page too.
 */
export function useChipReveal(rowRef: RefObject<HTMLElement | null>, activeKey: string): void {
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const revealCurrent = () => {
      const current = row.querySelector('[aria-current="page"]')
      if (current) reveal(row, current)
    }
    const revealFocused = (event: FocusEvent) => {
      if (event.target instanceof Element) reveal(row, event.target)
    }

    revealCurrent()
    const observer = new ResizeObserver(revealCurrent)
    observeRowAndChips(observer, row)
    row.addEventListener("focusin", revealFocused)
    return () => {
      observer.disconnect()
      row.removeEventListener("focusin", revealFocused)
    }
  }, [rowRef, activeKey])
}

/** Which ends of a sideways scrolling row have more chips past them. */
export function useChipRowFades(rowRef: RefObject<HTMLElement | null>): { start: boolean; end: boolean } {
  const [fades, setFades] = useState({ start: false, end: false })
  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const update = () => {
      const start = row.scrollLeft > 1
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1
      setFades((previous) => (previous.start === start && previous.end === end ? previous : { start, end }))
    }
    update()
    row.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observeRowAndChips(observer, row)
    return () => {
      observer.disconnect()
      row.removeEventListener("scroll", update)
    }
  }, [rowRef])
  return fades
}

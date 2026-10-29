/**
 * A sticky row of section chips for the long chart pages on phones. Tapping a
 * chip scrolls the page to that section, and the chip of the section at the
 * top of the screen lights up.
 *
 * Sections are marked with JumpTarget, a `display: contents` wrapper, so the
 * grids the panels sit in keep their layout. The bar measures and scrolls to
 * the wrapper's first element.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

export interface JumpSection {
  id: string
  label: string
}

/** Gap left between the bar and a section scrolled to the top. */
const SECTION_GAP = 12

export function JumpTarget({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div data-jump-target={id} className="contents">
      {children}
    </div>
  )
}

function targetElement(scroller: HTMLElement, id: string): HTMLElement | null {
  const wrapper = scroller.querySelector(`[data-jump-target="${id}"]`)
  return (wrapper?.firstElementChild as HTMLElement | null) ?? null
}

export function JumpBar({ sections }: { sections: readonly JumpSection[] }) {
  const isMobile = useIsMobile()
  const navRef = useRef<HTMLElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  // Null until the first check; until then every chip shows.
  const [present, setPresent] = useState<readonly string[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  // While a tap's scroll runs, the spy would light up every section it
  // passes, so it waits for the scroll to end.
  const jumpingRef = useRef(false)
  const jumpTimerRef = useRef(0)
  const scheduleRef = useRef(() => {})
  // The chip last tapped, until the user scrolls by hand. A tapped section
  // near the end can't reach the top, and the page stopping at its bottom
  // shouldn't hand the light to the last section.
  const tappedRef = useRef<string | null>(null)

  const paddedMainRef = useRef<HTMLElement | null>(null)

  const navCallbackRef = useCallback((node: HTMLElement | null) => {
    navRef.current = node
    const main = node?.closest<HTMLElement>("main") ?? null
    // The padding is set and cleared here, not in the effect: a table that
    // resets in this same commit reads it before any effect runs, and the
    // effect cleanup of the bar on the previous page would run after this
    // page's bar set it. React detaches the old ref before attaching the new.
    if (node && main) {
      main.style.scrollPaddingTop = `${node.offsetHeight}px`
    } else if (paddedMainRef.current) {
      paddedMainRef.current.style.scrollPaddingTop = ""
    }
    paddedMainRef.current = main
    setScroller(main)
  }, [])

  useEffect(() => {
    if (!scroller) return
    let frame = 0
    const update = () => {
      frame = 0
      const shown = sections.filter((section) => targetElement(scroller, section.id))
      setPresent((previous) =>
        previous?.length === shown.length && previous.every((id, index) => id === shown[index].id)
          ? previous
          : shown.map((section) => section.id),
      )
      if (jumpingRef.current || shown.length === 0) return
      const line = (navRef.current?.getBoundingClientRect().bottom ?? 0) + SECTION_GAP + 1
      let current = shown[0].id
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        const tapped = tappedRef.current
        current = tapped && shown.some((section) => section.id === tapped) ? tapped : shown[shown.length - 1].id
      } else {
        for (const section of shown) {
          const top = targetElement(scroller, section.id)?.getBoundingClientRect().top ?? Infinity
          if (top <= line) current = section.id
        }
      }
      setActive(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const endJump = () => {
      jumpingRef.current = false
      schedule()
    }
    const forgetTap = () => {
      tappedRef.current = null
    }
    const manualScrollEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const
    scheduleRef.current = schedule
    schedule()
    scroller.addEventListener("scroll", schedule, { passive: true })
    scroller.addEventListener("scrollend", endJump)
    for (const type of manualScrollEvents) scroller.addEventListener(type, forgetTap, { passive: true })
    // A section can mount after the bar (the map loads behind Suspense), so
    // presence is rechecked on DOM changes.
    const observer = new MutationObserver(schedule)
    observer.observe(scroller, { childList: true, subtree: true })
    // The bar's height as scroll padding, so scrolls the page makes for other
    // reasons (a table going back to its first row, focus moving to a row)
    // stop below the bar instead of under it.
    const nav = navRef.current
    const resizeObserver = new ResizeObserver(() => {
      scroller.style.scrollPaddingTop = `${nav?.offsetHeight ?? 0}px`
    })
    if (nav) resizeObserver.observe(nav)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(jumpTimerRef.current)
      jumpingRef.current = false
      tappedRef.current = null
      scheduleRef.current = () => {}
      scroller.removeEventListener("scroll", schedule)
      scroller.removeEventListener("scrollend", endJump)
      for (const type of manualScrollEvents) scroller.removeEventListener(type, forgetTap)
      observer.disconnect()
      resizeObserver.disconnect()
    }
  }, [scroller, sections])

  // Keep the lit chip in view inside the bar, also when the row's width changes.
  useEffect(() => {
    const chips = chipsRef.current
    const chip = chips?.querySelector<HTMLElement>(`[data-section="${active}"]`)
    if (!chips || !chip) return
    const center = (behavior: ScrollBehavior) =>
      chips.scrollTo({ left: chip.offsetLeft - (chips.clientWidth - chip.offsetWidth) / 2, behavior })
    center(prefersReducedMotion() ? "auto" : "smooth")
    // Only on a real width change: the observer's first report would cut the
    // smooth scroll above short.
    let width = chips.clientWidth
    const observer = new ResizeObserver(() => {
      if (chips.clientWidth === width) return
      width = chips.clientWidth
      center("auto")
    })
    observer.observe(chips)
    return () => observer.disconnect()
    // isMobile and present: the row is new after a remount, or its chips moved.
  }, [active, isMobile, present])

  const jump = (id: string) => {
    const target = scroller && targetElement(scroller, id)
    if (!scroller || !target) return
    const line = (navRef.current?.getBoundingClientRect().bottom ?? 0) + SECTION_GAP
    const wanted = scroller.scrollTop + target.getBoundingClientRect().top - line
    const top = Math.max(0, Math.min(wanted, scroller.scrollHeight - scroller.clientHeight))
    const reduced = prefersReducedMotion()
    tappedRef.current = id
    setActive(id)
    if (!reduced && Math.abs(top - scroller.scrollTop) >= 1) {
      jumpingRef.current = true
      // scrollend ends the lock; the timer covers browsers without it.
      window.clearTimeout(jumpTimerRef.current)
      jumpTimerRef.current = window.setTimeout(() => {
        jumpingRef.current = false
        scheduleRef.current()
      }, 1000)
    }
    scroller.scrollTo({ top, behavior: reduced ? "auto" : "smooth" })
    // Move focus with the page, so Tab goes on into the section rather than
    // to the next chip.
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }

  if (!isMobile) return null
  const shown = present ? sections.filter((section) => present.includes(section.id)) : sections

  return (
    <nav
      ref={navCallbackRef}
      aria-label="Page sections"
      className="sticky top-0 z-20 -mx-4 -mt-4 border-b border-border/50 bg-background/85 backdrop-blur-md"
    >
      <div
        ref={chipsRef}
        className="flex gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {shown.map((section) => (
          <Button
            key={section.id}
            type="button"
            variant="outline"
            size="sm"
            data-section={section.id}
            aria-current={active === section.id ? "location" : undefined}
            onClick={() => jump(section.id)}
            className={cn(
              "shrink-0 rounded-full text-muted-foreground",
              "aria-[current=location]:border-primary/50 aria-[current=location]:bg-primary/15 aria-[current=location]:text-primary",
            )}
          >
            {section.label}
          </Button>
        ))}
      </div>
    </nav>
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

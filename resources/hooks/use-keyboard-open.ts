import { useEffect, useState } from "react"
import { isKeyboardOpen } from "@/lib/phone-layout"

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

function isEditable(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly
  if (element instanceof HTMLInputElement) return !element.readOnly && !NON_TEXT_INPUT_TYPES.has(element.type)
  return element instanceof HTMLElement && element.isContentEditable
}

/**
 * Calls back whenever the keyboard or the visible area may have changed. iOS can
 * send one resize that still holds the full height, then report the keyboard
 * through scroll events only.
 */
function watchKeyboard(onChange: (open: boolean, viewport: VisualViewport) => void): () => void {
  const viewport = window.visualViewport
  if (!viewport || !window.matchMedia("(pointer: coarse)").matches) return () => {}

  // Browsers that resize the layout viewport for the keyboard shrink
  // innerHeight with it, so the comparison uses the tallest height seen at
  // this width instead.
  let width = window.innerWidth
  let tallest = window.innerHeight

  const update = () => {
    if (window.innerWidth !== width) {
      width = window.innerWidth
      tallest = window.innerHeight
    }
    tallest = Math.max(tallest, window.innerHeight)
    onChange(
      isKeyboardOpen({
        focusedEditable: isEditable(document.activeElement),
        scale: viewport.scale,
        viewportHeight: viewport.height,
        innerHeight: tallest,
      }),
      viewport,
    )
  }

  update()
  viewport.addEventListener("resize", update)
  viewport.addEventListener("scroll", update)
  document.addEventListener("focusin", update)
  document.addEventListener("focusout", update)
  return () => {
    viewport.removeEventListener("resize", update)
    viewport.removeEventListener("scroll", update)
    document.removeEventListener("focusin", update)
    document.removeEventListener("focusout", update)
  }
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => watchKeyboard((keyboardOpen) => setOpen(keyboardOpen)), [])
  return open
}

export function useDrawerAboveKeyboard(drawer: HTMLElement | null) {
  useEffect(() => {
    if (!drawer) return
    let shownHeight = 0
    let shownField: Element | null = null
    let pendingScroll = 0
    const stopWatching = watchKeyboard((open, viewport) => {
      const bottom = open ? Math.max(window.innerHeight - viewport.height - viewport.offsetTop, 0) : 0
      const height = open ? viewport.height : 0
      const field = open ? document.activeElement : null
      drawer.style.bottom = open ? `${bottom}px` : ""
      if (drawer.dataset.vaulDrawerDirection === "bottom") {
        drawer.style.maxHeight = open ? `calc(${viewport.height}px - env(safe-area-inset-top, 0px) - 8px)` : ""
      }
      if (field && drawer.contains(field) && (Math.abs(height - shownHeight) >= 1 || field !== shownField)) {
        cancelAnimationFrame(pendingScroll)
        pendingScroll = requestAnimationFrame(() => {
          if (document.activeElement === field) field.scrollIntoView({ block: "center", behavior: "instant" })
        })
      }
      shownHeight = height
      shownField = field
    })
    return () => {
      stopWatching()
      cancelAnimationFrame(pendingScroll)
    }
  }, [drawer])
}

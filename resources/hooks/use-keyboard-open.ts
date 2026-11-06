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

/** Whether the on-screen keyboard is up. */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

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
      setOpen(
        isKeyboardOpen({
          focusedEditable: isEditable(document.activeElement),
          scale: viewport.scale,
          viewportHeight: viewport.height,
          innerHeight: tallest,
        }),
      )
    }

    update()
    viewport.addEventListener("resize", update)
    document.addEventListener("focusin", update)
    document.addEventListener("focusout", update)
    return () => {
      viewport.removeEventListener("resize", update)
      document.removeEventListener("focusin", update)
      document.removeEventListener("focusout", update)
    }
  }, [])

  return open
}

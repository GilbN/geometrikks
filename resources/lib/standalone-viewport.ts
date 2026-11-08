import { isEditable } from "@/hooks/use-keyboard-open"
import { isViewportStuck } from "@/lib/phone-layout"

const KEYBOARD_SETTLE_MS = 140

function remeasureViewport(root: HTMLElement) {
  const scrolledElements = Array.from(root.querySelectorAll<HTMLElement>("*"))
    .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
    .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }))

  root.style.display = "none"
  void root.offsetHeight
  root.style.display = ""

  for (const { element, top, left } of scrolledElements) element.scrollTo({ top, left, behavior: "instant" })
}

/**
 * In an installed iOS app the keyboard can leave the layout viewport one status
 * bar short until the app is force-quit. Hiding and showing the full-height
 * root makes WebKit measure it again.
 */
export function restoreStandaloneViewportAfterKeyboard() {
  const root = document.getElementById("app")
  const viewport = window.visualViewport
  if (!root || !viewport || !window.matchMedia("(display-mode: standalone)").matches) return

  let width = window.innerWidth
  let tallest = window.innerHeight
  let settleTimer: number | undefined

  const trackHeight = () => {
    if (window.innerWidth !== width) {
      width = window.innerWidth
      tallest = window.innerHeight
    }
    tallest = Math.max(tallest, window.innerHeight)
  }

  const restoreIfStuck = () => {
    trackHeight()
    const stuck = isViewportStuck({
      focusedEditable: isEditable(document.activeElement),
      scale: viewport.scale,
      tallestHeight: tallest,
      innerHeight: window.innerHeight,
    })
    if (stuck) remeasureViewport(root)
  }

  const scheduleRestore = () => {
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(restoreIfStuck, KEYBOARD_SETTLE_MS)
  }

  window.addEventListener("resize", trackHeight)
  // A login that navigates away removes the focused field, which may not fire focusout.
  viewport.addEventListener("resize", scheduleRestore)
  document.addEventListener("focusout", scheduleRestore)
}

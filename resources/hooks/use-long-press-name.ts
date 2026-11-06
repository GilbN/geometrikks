import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react"

const HOLD_MS = 500
const SWALLOW_MS = 300

/**
 * Shows a control's name while it is held for 500ms. The click that ends the
 * hold is swallowed, so the control's action stays on `onClick` and runs only
 * on a tap or from the keyboard.
 */
export function useLongPressName() {
  const [open, setOpen] = useState(false)
  const holdTimer = useRef<number | undefined>(undefined)
  const swallowTimer = useRef<number | undefined>(undefined)
  const swallowClick = useRef(false)
  const stopWatchingRelease = useRef<(() => void) | undefined>(undefined)

  const cancelPress = () => {
    window.clearTimeout(holdTimer.current)
    holdTimer.current = undefined
    setOpen(false)
  }

  const endPress = () => {
    stopWatchingRelease.current?.()
    stopWatchingRelease.current = undefined
    cancelPress()
    window.clearTimeout(swallowTimer.current)
    if (swallowClick.current) {
      swallowTimer.current = window.setTimeout(() => {
        swallowClick.current = false
      }, SWALLOW_MS)
    }
  }

  useEffect(
    () => () => {
      stopWatchingRelease.current?.()
      window.clearTimeout(holdTimer.current)
      window.clearTimeout(swallowTimer.current)
    },
    [],
  )

  const bind = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      window.clearTimeout(swallowTimer.current)
      swallowClick.current = false
      if (event.button !== 0) return
      window.clearTimeout(holdTimer.current)
      // A release off the button never reaches its onPointerUp.
      stopWatchingRelease.current?.()
      window.addEventListener("pointerup", endPress, { once: true })
      window.addEventListener("pointercancel", endPress, { once: true })
      stopWatchingRelease.current = () => {
        window.removeEventListener("pointerup", endPress)
        window.removeEventListener("pointercancel", endPress)
      }
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = undefined
        swallowClick.current = true
        setOpen(true)
      }, HOLD_MS)
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (holdTimer.current === undefined && !open) return
      // A touch stays captured by the button it started on, so leaving it only shows in the coordinates.
      const rect = event.currentTarget.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      if (!inside) cancelPress()
    },
    // A mouse has no implicit capture, so once it leaves no pointermove arrives
    // here. A touch fires pointerleave only after its pointerup.
    onPointerLeave() {
      cancelPress()
    },
    onPointerUp: endPress,
    onPointerCancel: endPress,
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (!swallowClick.current) return
      swallowClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault()
    },
  }

  return { open, bind }
}

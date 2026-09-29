import * as React from "react"

const MOBILE_BREAKPOINT = 768

/** Reads the breakpoint synchronously. For one-shot decisions that can't
 *  wait for useIsMobile, which reports false until its effect has run. */
export function isMobileViewport(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(isMobileViewport())
    }
    mql.addEventListener("change", onChange)
    setIsMobile(isMobileViewport())
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

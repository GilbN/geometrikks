import * as React from "react"

/** Reactive matchMedia: re-renders when the query's match state changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener("change", onChange)
    setMatches(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}

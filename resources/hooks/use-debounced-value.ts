import { useEffect, useState } from "react"

/**
 * Returns a debounced copy of `value` that only updates after `delayMs`
 * has elapsed without further changes. Useful for text-input filters so
 * every keystroke doesn't trigger a fetch.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

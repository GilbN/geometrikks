import {
  createContext,
  createRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"

type CoverKind = "bar" | "toasts"

type PhoneChrome = {
  barCovered: boolean
  toastsCovered: boolean
  moreOpen: boolean
  setMoreOpen(open: boolean): void
  moreTriggerRef: RefObject<HTMLButtonElement | null>
}

type PhoneChromeContextValue = PhoneChrome & {
  cover(kind: CoverKind): () => void
}

const PhoneChromeContext = createContext<PhoneChromeContextValue>({
  barCovered: false,
  toastsCovered: false,
  moreOpen: false,
  setMoreOpen: () => {},
  moreTriggerRef: createRef<HTMLButtonElement>(),
  cover: () => () => {},
})

export function PhoneChromeProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Record<CoverKind, number>>({ bar: 0, toasts: 0 })
  const [moreOpen, setMoreOpen] = useState(false)
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)

  const cover = useCallback((kind: CoverKind) => {
    setCounts((current) => ({ ...current, [kind]: current[kind] + 1 }))
    return () => setCounts((current) => ({ ...current, [kind]: current[kind] - 1 }))
  }, [])

  const value = useMemo(
    () => ({
      barCovered: counts.bar > 0,
      toastsCovered: counts.bar > 0 || counts.toasts > 0,
      moreOpen,
      setMoreOpen,
      moreTriggerRef,
      cover,
    }),
    [counts, moreOpen, cover],
  )

  return <PhoneChromeContext.Provider value={value}>{children}</PhoneChromeContext.Provider>
}

function useCover(kind: CoverKind, open: boolean): void {
  const { cover } = useContext(PhoneChromeContext)
  useEffect(() => (open ? cover(kind) : undefined), [cover, kind, open])
}

/** A landscape surface covering the bottom edge: hides the bar and the map pill
 *  and moves toasts to the top while open. */
export function useCoverBar(open: boolean): void {
  useCover("bar", open)
}

/** A portrait detail panel: moves toasts to the top while open. */
export function useCoverToasts(open: boolean): void {
  useCover("toasts", open)
}

export function usePhoneChrome(): PhoneChrome {
  const { barCovered, toastsCovered, moreOpen, setMoreOpen, moreTriggerRef } = useContext(PhoneChromeContext)
  return { barCovered, toastsCovered, moreOpen, setMoreOpen, moreTriggerRef }
}

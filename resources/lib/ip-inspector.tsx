/**
 * Which IP the inspector shows lives in the URL (`?inspect=`), declared on
 * the root route so every page inherits it. Where it was opened from (a map
 * location id) is React state only: a pasted link has no origin.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"

interface OriginState {
  originLocationId: number | null
  setOrigin: (id: number | null) => void
}

const OriginContext = createContext<OriginState>({ originLocationId: null, setOrigin: () => {} })

export function IpInspectorProvider({ children }: { children: React.ReactNode }) {
  const [originLocationId, setOrigin] = useState<number | null>(null)
  const value = useMemo(() => ({ originLocationId, setOrigin }), [originLocationId])
  return <OriginContext.Provider value={value}>{children}</OriginContext.Provider>
}

export function useIpInspector() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false })
  const { originLocationId, setOrigin } = useContext(OriginContext)
  const ip = typeof search.inspect === "string" && search.inspect ? search.inspect : undefined

  const open = useCallback(
    (nextIp: string, fromLocationId?: number) => {
      setOrigin(fromLocationId ?? null)
      // Pushed, not replaced: Back closes the sheet.
      void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, inspect: nextIp }) })
    },
    [navigate, setOrigin],
  )

  const close = useCallback(() => {
    setOrigin(null)
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, inspect: undefined }),
      replace: true,
    })
  }, [navigate, setOrigin])

  return { ip, originLocationId, open, close }
}

/**
 * Which IP the inspector shows lives in the URL (`?inspect=`), declared on
 * the root route so every page inherits it. Where it was opened from (a map
 * location id) is React state only: a pasted link has no origin.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"

interface ActionsState {
  open: (ip: string, fromLocationId?: number) => void
  close: () => void
}

const ActionsContext = createContext<ActionsState | null>(null)
const OriginContext = createContext<number | null | undefined>(undefined)

export function IpInspectorProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [originLocationId, setOrigin] = useState<number | null>(null)

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

  const actions = useMemo(() => ({ open, close }), [open, close])
  return (
    <ActionsContext.Provider value={actions}>
      <OriginContext.Provider value={originLocationId}>{children}</OriginContext.Provider>
    </ActionsContext.Provider>
  )
}

export function useIpInspectorActions() {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error("useIpInspectorActions must be used within an IpInspectorProvider")
  return actions
}

export function useIpInspectorOrigin() {
  const originLocationId = useContext(OriginContext)
  if (originLocationId === undefined) {
    throw new Error("useIpInspectorOrigin must be used within an IpInspectorProvider")
  }
  return originLocationId
}

export function useIpInspector() {
  const inspect = useSearch({ strict: false, select: (search) => search.inspect })
  const actions = useIpInspectorActions()
  const originLocationId = useIpInspectorOrigin()
  const ip = typeof inspect === "string" && inspect ? inspect : undefined

  return { ip, originLocationId, ...actions }
}

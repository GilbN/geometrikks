/**
 * Which IP the inspector shows lives in the URL (`?inspect=`), declared on
 * the root route so every page inherits it. Where it was opened from (a map
 * location id) is React state only: a pasted link has no origin.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useOverlayEntry, useOverlayHistory } from "@/lib/overlay-history"

interface ActionsState {
  open: (ip: string, fromLocationId?: number) => void
  close: () => void
}

const ActionsContext = createContext<ActionsState | null>(null)
const OriginContext = createContext<number | null | undefined>(undefined)

const INSPECTOR_OVERLAY = "inspector"

export function IpInspectorProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const overlays = useOverlayHistory()
  const [originLocationId, setOrigin] = useState<number | null>(null)

  const open = useCallback(
    (nextIp: string, fromLocationId?: number) => {
      setOrigin(fromLocationId ?? null)
      // Pushed, not replaced: Back closes the sheet.
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, inspect: nextIp }),
        state: overlays.stateFor(INSPECTOR_OVERLAY),
      })
    },
    [navigate, overlays, setOrigin],
  )

  const close = useCallback(() => {
    setOrigin(null)
    if (overlays.backFrom(INSPECTOR_OVERLAY)) return
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, inspect: undefined }),
      replace: true,
    })
  }, [navigate, overlays, setOrigin])

  useOverlayEntry(INSPECTOR_OVERLAY, useInspectedIp() !== undefined, close, { adopt: true })

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

/** The `inspect` value for a link out of the sheet. Below `sm` the sheet fills
 *  the screen and would hide the page the link opens, so there the link
 *  closes it. Back reopens it. */
export function useInspectOnNavigate(ip: string): string | undefined {
  const sheetFillsScreen = useMediaQuery("(width < 40rem)")
  return sheetFillsScreen ? undefined : ip
}

function useInspectedIp(): string | undefined {
  const inspect = useSearch({ strict: false, select: (search) => search.inspect })
  return typeof inspect === "string" && inspect ? inspect : undefined
}

export function useIpInspector() {
  const ip = useInspectedIp()
  const actions = useIpInspectorActions()
  const originLocationId = useIpInspectorOrigin()

  return { ip, originLocationId, ...actions }
}

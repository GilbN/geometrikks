/**
 * Which IP the inspector shows lives in the URL (`?inspect=`), declared on
 * the root route so every page inherits it. Where it was opened from (a map
 * location id) is React state only: a pasted link has no origin.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useOverlayEntry, useOverlayHistory } from "@/lib/overlay-history"
import {
  INSPECTOR_DOCK_QUERY,
  loadInspectorDockedPreference,
  saveInspectorDockedPreference,
} from "@/lib/inspector-dock-preference"

interface ActionsState {
  open: (ip: string, fromLocationId?: number) => void
  close: () => void
}

const ActionsContext = createContext<ActionsState | null>(null)
const OriginContext = createContext<number | null | undefined>(undefined)

interface DockState {
  /** The viewport is wide enough to dock. */
  canDock: boolean
  /** The inspector shows docked beside the page rather than over it. */
  docked: boolean
  setDocked: (docked: boolean) => void
}

const DockContext = createContext<DockState | null>(null)

const INSPECTOR_OVERLAY = "inspector"

export function IpInspectorProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const overlays = useOverlayHistory()
  const inspectedIp = useInspectedIp()
  const [originLocationId, setOrigin] = useState<number | null>(null)
  const canDock = useMediaQuery(INSPECTOR_DOCK_QUERY)
  const [dockPreferred, setDockPreferred] = useState(loadInspectorDockedPreference)
  const docked = canDock && dockPreferred
  const setDocked = useCallback((next: boolean) => {
    setDockPreferred(next)
    saveInspectorDockedPreference(next)
  }, [])

  const open = useCallback(
    (nextIp: string, fromLocationId?: number) => {
      setOrigin(fromLocationId ?? null)
      // Pushed, not replaced: Back closes the sheet. The dock stays usable
      // while it is open, so a second IP replaces the entry and one Back
      // still closes it.
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, inspect: nextIp }),
        state: overlays.stateFor(INSPECTOR_OVERLAY),
        replace: docked && inspectedIp !== undefined,
      })
    },
    [navigate, overlays, setOrigin, docked, inspectedIp],
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

  useOverlayEntry(INSPECTOR_OVERLAY, inspectedIp !== undefined, close, { adopt: true })

  const actions = useMemo(() => ({ open, close }), [open, close])
  const dock = useMemo(() => ({ canDock, docked, setDocked }), [canDock, docked, setDocked])
  return (
    <ActionsContext.Provider value={actions}>
      <OriginContext.Provider value={originLocationId}>
        <DockContext.Provider value={dock}>{children}</DockContext.Provider>
      </OriginContext.Provider>
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

export function useIpInspectorDock() {
  const dock = useContext(DockContext)
  if (!dock) throw new Error("useIpInspectorDock must be used within an IpInspectorProvider")
  return dock
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

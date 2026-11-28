/**
 * Which IP the inspector shows lives in the URL (`?inspect=`), declared on
 * the root route so every page inherits it. Where it was opened from (a map
 * location id) is React state only: a pasted link has no origin.
 *
 * The provider also owns the dock, the one column beside the page. It shows
 * the inspector or a page's record, never both.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { useMediaQuery } from "@/hooks/use-media-query"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { useOverlayEntry, useOverlayHistory } from "@/lib/overlay-history"
import { NO_RECORD } from "@/lib/record-search"
import {
  INSPECTOR_DOCK_QUERY,
  loadInspectorDockedPreference,
  saveInspectorDockedPreference,
} from "@/lib/inspector-dock-preference"

interface ActionsState {
  open: (ip: string, fromLocationId?: number) => void
  close: () => void
}

declare module "@tanstack/history" {
  interface HistoryState {
    /** The record the inspector took over from, which the entry below shows. */
    fromRecord?: string
  }
}

const ActionsContext = createContext<ActionsState | null>(null)
const OriginContext = createContext<number | null | undefined>(undefined)

interface DockState {
  /** The viewport is wide enough to dock. */
  canDock: boolean
  /** The inspector shows docked beside the page rather than over it. */
  docked: boolean
  setDocked: (docked: boolean) => void
  /** The app shell's column that a docked record renders into. */
  slot: HTMLElement | null
  setSlot: (slot: HTMLElement | null) => void
}

const DockContext = createContext<DockState | null>(null)

// The label of the record on screen, which the inspector's link back names.
const ShownRecordContext = createContext<{ current: string | undefined } | null>(null)

const INSPECTOR_OVERLAY = "inspector"

const openListeners = new Set<(ip: string) => void>()

/** Runs on every open. Opening the IP already shown leaves the URL as it is,
 *  so the URL alone misses it. */
export function onIpInspectorOpen(listener: (ip: string) => void): () => void {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

export function IpInspectorProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const router = useRouter()
  const overlays = useOverlayHistory()
  const inspectedIp = useInspectedIp()
  const [originLocationId, setOrigin] = useState<number | null>(null)
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY)
  const phone = usePhoneLayout()
  // A phone held sideways can be this wide too; it keeps the phone sheet.
  const canDock = wide && !phone
  const [dockPreferred, setDockPreferred] = useState(loadInspectorDockedPreference)
  const docked = canDock && dockPreferred
  const setDocked = useCallback((next: boolean) => {
    setDockPreferred(next)
    saveInspectorDockedPreference(next)
  }, [])
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const shownRecord = useRef<string | undefined>(undefined)

  // A ref, so `open` keeps its identity and every row's menu does not
  // re-render each time the docked inspector switches IPs.
  const replaceOnOpen = useRef(false)
  const recordOpenRef = useRef(false)
  const recordOpen = useSearch({
    strict: false,
    select: (search) => search.record !== undefined,
  })
  useLayoutEffect(() => {
    replaceOnOpen.current = docked && inspectedIp !== undefined && !recordOpen
    recordOpenRef.current = recordOpen
  })

  const open = useCallback(
    (nextIp: string, fromLocationId?: number) => {
      setOrigin(fromLocationId ?? null)
      for (const listener of openListeners) listener(nextIp)
      // Pushed, not replaced: Back closes the sheet. The dock stays usable
      // while it is open, so a second IP replaces the entry and one Back
      // still closes it. The inspector takes over from an open record in the
      // same step, so Back from it returns to that record.
      const fromRecord = recordOpenRef.current
        ? shownRecord.current
        : replaceOnOpen.current
          ? router.history.location.state.fromRecord
          : undefined
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...NO_RECORD, inspect: nextIp }),
        state: { ...overlays.stateFor(INSPECTOR_OVERLAY), fromRecord },
        replace: replaceOnOpen.current,
      })
    },
    [navigate, router, overlays, setOrigin],
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
  const dock = useMemo(
    () => ({ canDock, docked, setDocked, slot, setSlot }),
    [canDock, docked, setDocked, slot],
  )
  return (
    <ActionsContext.Provider value={actions}>
      <OriginContext.Provider value={originLocationId}>
        <DockContext.Provider value={dock}>
          <ShownRecordContext.Provider value={shownRecord}>{children}</ShownRecordContext.Provider>
        </DockContext.Provider>
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

/** Names the record on screen while `label` is set, so an inspector opened
 *  from it can link back. */
export function useShownRecord(label: string | undefined) {
  const shown = useContext(ShownRecordContext)
  useLayoutEffect(() => {
    if (!shown || label === undefined) return
    shown.current = label
    return () => {
      if (shown.current === label) shown.current = undefined
    }
  }, [shown, label])
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

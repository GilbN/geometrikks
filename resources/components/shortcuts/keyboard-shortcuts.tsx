/**
 * Listens for the app's keyboard shortcuts and runs them. Shortcuts that
 * belong to one control, like T for the range picker, are registered by that
 * control with useShortcutAction; the rest run here. The registry and the
 * cheat sheet's open state live in this module, so the shell mounts
 * KeyboardShortcuts once beside the page instead of around it.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import { ShortcutsDialog } from "@/components/shortcuts/shortcuts-dialog"
import {
  filterCellUnderPointer,
  focusPageFilter,
  moveRow,
  shortcutRowData,
  stepPage,
  targetRow,
  trackPointer,
} from "@/components/data/table-shortcuts"
import { fetchCrowdsecStatus } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { useIpInspectorActions } from "@/lib/ip-inspector"
import { requestLiveTail } from "@/lib/live-tail-request"
import { queryKeys } from "@/lib/queries"
import { singleKeyShortcutsEnabled } from "@/lib/shortcut-preference"
import {
  GO_TO_PATHS,
  MODIFIER_KEYS,
  SEQUENCE_TIMEOUT_MS,
  isInOverlay,
  isTypingTarget,
  matchKey,
  modalLayerOpen,
  type ShortcutId,
} from "@/lib/shortcuts"
import { useTimeRange } from "@/lib/time-range-context"

type Handler = () => boolean | void

const registered = new Map<ShortcutId, Handler[]>()

function register(id: ShortcutId, handler: Handler): () => void {
  registered.set(id, [...(registered.get(id) ?? []), handler])
  return () =>
    registered.set(
      id,
      (registered.get(id) ?? []).filter((entry) => entry !== handler),
    )
}

let cheatSheetOpen = false
const cheatSheetListeners = new Set<() => void>()

function setCheatSheetOpen(open: boolean): void {
  cheatSheetOpen = open
  for (const listener of cheatSheetListeners) listener()
}

function subscribeCheatSheet(listener: () => void): () => void {
  cheatSheetListeners.add(listener)
  return () => cheatSheetListeners.delete(listener)
}

let returnFocusTo: HTMLElement | null = null

/** Opens the cheat sheet. Closing it puts focus back on `returnTo`, or on
 *  whatever had focus when it opened, such as a table row. */
export function openShortcutsCheatSheet(returnTo?: HTMLElement | null): void {
  returnFocusTo =
    returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  setCheatSheetOpen(true)
}

function restoreFocus(event: Event): void {
  const target = returnFocusTo
  returnFocusTo = null
  if (!target?.isConnected || target === document.body) return
  event.preventDefault()
  target.focus({ preventScroll: true })
}

/** Binds a shortcut to a handler while the calling component is mounted. The
 *  newest registration wins. A handler that returns false leaves the key alone. */
export function useShortcutAction(id: ShortcutId, handler: Handler | null): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const active = handler !== null
  useEffect(() => {
    if (!active) return
    return register(id, () => handlerRef.current?.())
  }, [id, active])
}

export function KeyboardShortcuts() {
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { refresh } = useTimeRange()
  const { open: inspect } = useIpInspectorActions()
  const sheetOpen = useSyncExternalStore(subscribeCheatSheet, () => cheatSheetOpen)
  const [banOpen, setBanOpen] = useState(false)
  const banReturnFocus = useRef<HTMLElement | null>(null)
  const pendingPrefix = useRef<{ key: string; timer: number } | null>(null)

  const builtIn = useCallback(
    (id: ShortcutId): boolean => {
      const path = GO_TO_PATHS[id]
      if (path) {
        void navigate({ to: path })
        return true
      }
      switch (id) {
        case "cheat-sheet":
          openShortcutsCheatSheet()
          return true
        case "refresh":
          refresh()
          return true
        case "focus-filter":
          return focusPageFilter()
        case "live-tail":
          requestLiveTail()
          // On the page already, the request switches the tab and keeps the History filters.
          if (router.state.location.pathname !== "/access-logs") {
            void navigate({ to: "/access-logs" })
          }
          return true
        case "ban": {
          // A slow status answer must not pull focus from whatever the user did next.
          const focusedBefore = document.activeElement
          const pathBefore = router.state.location.pathname
          void queryClient
            .fetchQuery({
              queryKey: queryKeys.crowdsec.status,
              queryFn: fetchCrowdsecStatus,
              staleTime: 60_000,
            })
            .then((status) => {
              if (!status?.writeEnabled) return
              if (document.activeElement !== focusedBefore) return
              if (router.state.location.pathname !== pathBefore) return
              banReturnFocus.current =
                focusedBefore instanceof HTMLElement && focusedBefore !== document.body
                  ? focusedBefore
                  : null
              setBanOpen(true)
            })
            .catch(() => {})
          return true
        }
        case "row-next":
          return moveRow(1)
        case "row-previous":
          return moveRow(-1)
        case "page-next":
          return stepPage(1)
        case "page-previous":
          return stepPage(-1)
        case "row-inspect": {
          const row = targetRow()
          const data = row ? shortcutRowData(row) : undefined
          if (!data) return false
          inspect(data.values.ip)
          return true
        }
        case "row-copy": {
          const row = targetRow()
          const data = row ? shortcutRowData(row) : undefined
          if (!data) return false
          const ip = data.values.ip
          void copyText(ip).then((copied) => {
            if (copied) toast.success(`Copied ${ip}`)
            else toast.error("The browser blocked the copy.")
          })
          return true
        }
        case "cell-filter": {
          const cell = filterCellUnderPointer()
          const data = cell ? shortcutRowData(cell.row) : undefined
          const target = data?.targetsFor?.(data.values).find((entry) => entry.noun === cell?.noun)
          if (!target?.include) return false
          if (target.state === "include") {
            target.remove()
            toast(`Removed the ${target.noun} filter ${target.value}`)
          } else {
            target.include()
            toast(`Filtered by ${target.noun} ${target.value}`)
          }
          return true
        }
        default:
          return false
      }
    },
    [navigate, router, queryClient, refresh, inspect],
  )

  useEffect(() => trackPointer(), [])
  // A sign-out unmounts the shell. Closing here keeps the sheet shut after the next sign-in.
  useEffect(() => () => setCheatSheetOpen(false), [])

  useEffect(() => {
    const clearPrefix = () => {
      if (pendingPrefix.current) window.clearTimeout(pendingPrefix.current.timer)
      pendingPrefix.current = null
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (isTypingTarget(event.target) || isInOverlay(event.target) || modalLayerOpen()) {
        clearPrefix()
        return
      }
      if (!singleKeyShortcutsEnabled()) return
      const result = matchKey(event, pendingPrefix.current?.key ?? null)
      if (result.kind === "waiting") {
        // Block a held G so it repeats nothing. A lone modifier keeps its default.
        if (!MODIFIER_KEYS.has(event.key)) event.preventDefault()
        return
      }
      if (result.kind === "pending") {
        clearPrefix()
        pendingPrefix.current = {
          key: result.prefix,
          timer: window.setTimeout(clearPrefix, SEQUENCE_TIMEOUT_MS),
        }
        event.preventDefault()
        return
      }
      clearPrefix()
      if (result.kind === "none") return
      const id = result.shortcut.id
      const handler = registered.get(id)?.at(-1)
      const handled = handler ? handler() !== false : builtIn(id)
      if (handled) event.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      clearPrefix()
    }
  }, [builtIn])

  return (
    <>
      <ShortcutsDialog
        open={sheetOpen}
        onOpenChange={setCheatSheetOpen}
        onCloseAutoFocus={restoreFocus}
      />
      <BanIpDialog open={banOpen} onOpenChange={setBanOpen} returnFocusTo={banReturnFocus} />
    </>
  )
}

/**
 * Opens and closes a page's record through the URL, the way the IP inspector
 * does with `?inspect=`: opening pushes an entry, so Back closes the record,
 * and a link or a reload opens it again. A record takes the dock from the
 * inspector, and another record replaces a docked one's entry, so one Back
 * still closes the dock.
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useIpInspectorDock } from "@/lib/ip-inspector"
import { useOverlayEntry, useOverlayHistory } from "@/lib/overlay-history"
import { NO_RECORD, type RecordSearch } from "@/lib/record-search"

const RECORD_OVERLAY = "record"

function useCloseRecord() {
  const navigate = useNavigate()
  const overlays = useOverlayHistory()
  return useCallback(() => {
    if (overlays.backFrom(RECORD_OVERLAY)) return
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...NO_RECORD }),
      replace: true,
    })
  }, [navigate, overlays])
}

export function useRecordLink() {
  const navigate = useNavigate()
  const overlays = useOverlayHistory()
  const close = useCloseRecord()
  const current = useSearch({
    strict: false,
    select: (search) => ({ record: search.record, at: search.at }),
    structuralSharing: true,
  })
  const { docked } = useIpInspectorDock()
  // A ref, so `open` keeps its identity while records change.
  const replaceOnOpen = useRef(false)
  useLayoutEffect(() => {
    replaceOnOpen.current = docked && current.record !== undefined
  })

  const open = useCallback(
    (next: RecordSearch, extra?: Record<string, unknown>) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          ...extra,
          ...NO_RECORD,
          inspect: undefined,
          ...next,
        }),
        state: overlays.stateFor(RECORD_OVERLAY),
        replace: replaceOnOpen.current,
      })
    },
    [navigate, overlays],
  )

  return useMemo(() => ({ search: current, open, close }), [current, open, close])
}

/** Registers the record's history entry for the whole app. A page's table
 *  unmounts when you leave it, and Back to its record lands before the table
 *  mounts again, so a registration there would read as stale and Back would
 *  skip the record. */
export function RecordOverlayEntry() {
  const close = useCloseRecord()
  const open = useSearch({ strict: false, select: (search) => search.record !== undefined })
  useOverlayEntry(RECORD_OVERLAY, open, close, { adopt: true, openAt: hrefOpensRecord })
  return null
}

function hrefOpensRecord(href: string): boolean {
  const query = href.split("#")[0].split("?")[1] ?? ""
  return new URLSearchParams(query).has("record")
}

/**
 * Opens and closes a page's record through the URL, the way the IP inspector
 * does with `?inspect=`: opening pushes an entry, so Back closes the record,
 * and a link or a reload opens it again.
 */
import { useCallback } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useOverlayEntry, useOverlayHistory } from "@/lib/overlay-history"
import { NO_RECORD, type RecordSearch } from "@/lib/record-search"

const RECORD_OVERLAY = "record"

export function useRecordLink() {
  const navigate = useNavigate()
  const overlays = useOverlayHistory()
  const current = useSearch({
    strict: false,
    select: (search) => ({ record: search.record, at: search.at }),
    structuralSharing: true,
  })

  const open = useCallback(
    (next: RecordSearch, extra?: Record<string, unknown>) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...extra, ...NO_RECORD, ...next }),
        state: overlays.stateFor(RECORD_OVERLAY),
      })
    },
    [navigate, overlays],
  )

  const close = useCallback(() => {
    if (overlays.backFrom(RECORD_OVERLAY)) return
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...NO_RECORD }),
      replace: true,
    })
  }, [navigate, overlays])

  useOverlayEntry(RECORD_OVERLAY, current.record !== undefined, close, { adopt: true })

  return { search: current, open, close }
}

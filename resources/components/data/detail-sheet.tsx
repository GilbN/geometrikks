import { useId, useRef } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { isClientError } from "@/lib/crowdsec-errors"
import { useOverlayEntry } from "@/lib/overlay-history"
import { cn } from "@/lib/utils"

// An IP inspector can replace a record sheet. Keep the original row as a
// fallback when the inspector's immediate opener unmounts with that sheet.
const sheetOpeners = new WeakMap<EventTarget, HTMLElement[]>()

/** Right-side record viewer: full-screen on phones, a bounded panel from
 * `sm` up. The body scrolls; the header and the optional footer stay. */
export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  actions,
  className,
  historyEntry = true,
  returnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  /** Header buttons placed before the close button. */
  actions?: React.ReactNode
  className?: string
  /** Off for a sheet whose opener pushes a history entry of its own. */
  historyEntry?: boolean
  /** Where focus goes on close when every element that opened the sheet is gone. */
  returnFocus?: () => HTMLElement | null
}) {
  const openerRef = useRef<HTMLElement[]>([])
  const contentRef = useRef<HTMLDivElement>(null)
  const overlayId = useId()
  useOverlayEntry(`detail-sheet-${overlayId}`, historyEntry && open, () => onOpenChange(false))
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={contentRef}
        side="right"
        size="full-mobile"
        aria-modal="true"
        showCloseButton={false}
        className={cn("gap-0", className)}
        onOpenAutoFocus={(event) => {
          const opener = document.activeElement
          const previousSheet =
            opener?.closest('[data-slot="sheet-content"]') ??
            document.querySelector('[data-slot="sheet-content"][data-state="closed"]')
          const previousOpeners = previousSheet ? (sheetOpeners.get(previousSheet) ?? []) : []
          openerRef.current =
            opener instanceof HTMLElement && opener !== document.body
              ? [opener, ...previousOpeners]
              : previousOpeners
          if (event.target) sheetOpeners.set(event.target, openerRef.current)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (document.querySelector('[data-slot="sheet-content"][data-state="open"]')) return
          // Something that replaced the sheet, such as the docked inspector, took focus.
          const active = document.activeElement
          if (active && active !== document.body && !contentRef.current?.contains(active)) return
          const target = openerRef.current.find((element) => element.isConnected) ?? returnFocus?.()
          target?.focus({ preventScroll: true })
        }}
      >
        <SheetHeader className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border/50">
          <SheetTitle>{title}</SheetTitle>
          {/* Spans the description row too, so it centres on the whole header. The negative margins
              stop it from making a title-only header taller. */}
          <div className={cn("flex items-center gap-1", description && "row-span-2")}>
            {actions}
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-my-1.5 pointer-coarse:-my-3 pointer-coarse:size-11"
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </SheetClose>
          </div>
          <SheetDescription className={cn(!description && "sr-only")}>
            {description ?? "Record details"}
          </SheetDescription>
        </SheetHeader>
        <div
          data-slot="detail-sheet-content"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
        >
          {children}
        </div>
        {footer && (
          <div
            data-slot="detail-sheet-footer"
            className="shrink-0 border-t border-border/50 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            {footer}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Label/value row for a detail sheet. Pass `mono` for IPs, URLs and
 * other machine strings. Missing values render as "Not recorded" so the
 * field list is the same for every record. */
export function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  const empty = value === null || value === undefined || value === ""
  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)] gap-x-3 gap-y-0.5 border-b border-border/40 py-2 text-sm last:border-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words",
          mono && "font-mono text-xs",
          empty && "text-muted-foreground",
        )}
      >
        {empty ? "Not recorded" : value}
      </dd>
    </div>
  )
}

export type RecordStatus = "loading" | "missing" | "failed"

/** Where a record from a link stands while the sheet has nothing to show. A
 *  4xx, or a lookup that found no row, means the link is wrong or retention
 *  removed the record. */
export function recordStatus(query: { error: unknown; data?: unknown }): RecordStatus {
  if (query.data === null || (query.error && isClientError(query.error))) return "missing"
  return query.error ? "failed" : "loading"
}

/** The body of a record sheet whose record is still loading or did not load,
 *  as when it opens from a link. */
export function RecordPending({ status, noun }: { status: RecordStatus; noun: string }) {
  if (status === "loading")
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  return (
    <p className="text-sm text-muted-foreground">
      {status === "missing"
        ? `This ${noun} is no longer stored, or the link is wrong.`
        : `Could not load this ${noun}.`}
    </p>
  )
}

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react"
import { PanelRight, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** The inspector beside the page on a wide screen. It is a column of the app
 *  shell rather than an overlay, so the page stays usable. Laid out like a
 *  DetailSheet. */
export function InspectorDock({
  title,
  description,
  actions,
  footer,
  onClose,
  returnFocus,
  focusToggle,
  contentKey,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  onClose: () => void
  /** The page element that takes focus when the dock closes from inside. */
  returnFocus: () => HTMLElement | null
  /** Focus the dock toggle on mount, for a dock opened from the overlay's toggle. */
  focusToggle: boolean
  /** The body scrolls back to the top when this changes. */
  contentKey: string | undefined
  children: ReactNode
}) {
  const titleId = useId()
  const descriptionId = useId()
  const asideRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [contentKey])

  const focusToggleOnMount = useRef(focusToggle)
  useEffect(() => {
    if (!focusToggleOnMount.current) return
    asideRef.current
      ?.querySelector<HTMLElement>("[data-dock-toggle]")
      ?.focus({ preventScroll: true })
  }, [])

  const close = () => {
    const active = document.activeElement
    if (!active || active === document.body || asideRef.current?.contains(active)) {
      returnFocus()?.focus({ preventScroll: true })
    }
    onClose()
  }

  return (
    <aside
      ref={asideRef}
      data-slot="inspector-dock"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className="flex h-(--app-height) w-[31rem] shrink-0 min-[120rem]:w-[32.5rem] flex-col border-l border-border/50 bg-panel text-sm"
      onKeyDown={(event) => {
        // Menus and popovers opened from the dock portal out of it, but React
        // still bubbles their keys here. Escape in one closes only that menu.
        if (event.key !== "Escape" || event.defaultPrevented) return
        if (!event.currentTarget.contains(event.target as Node)) return
        event.preventDefault()
        close()
      }}
    >
      <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-border/50 p-4">
        <h2 id={titleId} className="font-medium text-foreground">
          {title}
        </h2>
        <div className={cn("flex items-center gap-1", description && "row-span-2")}>
          {actions}
          <Button
            variant="ghost"
            size="icon-sm"
            className="-my-1.5 pointer-coarse:-my-3 pointer-coarse:size-11"
            onClick={close}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </div>
        {description && (
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {children}
      </div>
      {footer && <div className="shrink-0 border-t border-border/50 px-4 py-3">{footer}</div>}
    </aside>
  )
}

/** Moves the inspector between the dock and the overlay. Shown only where
 *  the viewport is wide enough to dock. */
export function DockToggle({
  docked,
  onDockedChange,
}: {
  docked: boolean
  onDockedChange: (docked: boolean) => void
}) {
  const label = docked ? "Undock the inspector" : "Dock the inspector beside the page"
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-my-1.5 pointer-coarse:-my-3 pointer-coarse:size-11"
      data-dock-toggle=""
      title={label}
      aria-label={label}
      onClick={() => onDockedChange(!docked)}
    >
      <PanelRight />
    </Button>
  )
}

const OUTSIDE_PAGE = [
  '[data-slot="inspector-dock"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-radix-popper-content-wrapper]",
].join(", ")

/** The last element focused on the page itself, outside the inspector and
 *  any menu, dialog or popover. The inspector hands focus back to it when
 *  the element that opened it is gone. */
export function useLastPageFocus(): () => HTMLElement | null {
  const lastRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target !== document.body &&
        !target.closest(OUTSIDE_PAGE)
      )
        lastRef.current = target
    }
    document.addEventListener("focusin", onFocusIn)
    return () => document.removeEventListener("focusin", onFocusIn)
  }, [])
  return () => (lastRef.current?.isConnected ? lastRef.current : null)
}

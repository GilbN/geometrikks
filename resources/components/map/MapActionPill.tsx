import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import { Focus, Layers, Radio, Server } from "lucide-react"
import { TAB_BAR_SURFACE } from "@/components/phone-nav/tab-bar"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLongPressName } from "@/hooks/use-long-press-name"
import { usePhoneMapSide } from "@/hooks/use-phone-map"
import { PILL_WIDTH, PILL_WIDTH_COMPACT, pillSize, type PillSize } from "@/lib/phone-pill"
import { cn } from "@/lib/utils"
import { PILL_SIDE_EDGE, tabBarTop } from "./phone-map-actions"

/** The pill's size for the room between 8px under the map's top and 12px above the tab bar. */
export function usePillSize(map: HTMLElement | undefined): PillSize {
  const [size, setSize] = useState<PillSize>("full")

  useLayoutEffect(() => {
    if (!map) return
    const measure = () => setSize(pillSize(map.clientHeight - 8 - (tabBarTop() + 12)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(map)
    return () => observer.disconnect()
  }, [map])

  return size
}

const PILL_BUTTON =
  "relative rounded-full p-0 touch-none [-webkit-touch-callout:none] hover:bg-transparent dark:hover:bg-transparent active:bg-foreground/5 dark:active:bg-foreground/5 aria-disabled:cursor-default aria-disabled:opacity-50"

const PILL_ICON = "size-[22px]"

const LIVE_ON = "bg-foreground/9 text-primary hover:bg-foreground/9 hover:text-primary dark:hover:bg-foreground/9"

function PillButton({
  name,
  compact,
  unavailable = false,
  pressed,
  className,
  onClick,
  wrap = (button) => button,
  children,
}: {
  name: string
  compact: boolean
  unavailable?: boolean
  pressed?: boolean
  className?: string
  onClick?: () => void
  wrap?: (button: ReactElement) => ReactElement
  children: ReactNode
}) {
  const press = useLongPressName()
  const [focusOpen, setFocusOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <Tooltip
      open={press.open || focusOpen}
      // Radix also opens on hover and on any focus, including the focus the
      // Layers drawer hands back when it closes; only keyboard focus shows it.
      onOpenChange={(open) => setFocusOpen(open && !!buttonRef.current?.matches(":focus-visible"))}
    >
      <TooltipTrigger asChild>
        {wrap(
          <Button
            ref={buttonRef}
            variant="ghost"
            size="icon"
            aria-label={name}
            aria-pressed={pressed}
            aria-disabled={unavailable || undefined}
            onClick={unavailable ? undefined : onClick}
            {...press.bind}
            className={cn(PILL_BUTTON, compact ? "size-10" : "size-11", className)}
          >
            {children}
          </Button>,
        )}
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="rounded-full text-sm">
        {name}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The phone map's actions as a vertical icon pill on the right, above the tab
 * bar. A long press shows each button's name. In its two-button size only
 * Layers and Live show; the Layers drawer's tools menu takes the other two.
 */
export function MapActionPill({
  size,
  liveMode,
  demoTraffic,
  activeFilterCount,
  canFit,
  canGoToServer,
  onFit,
  onGoToServer,
  onToggleLive,
  layersTrigger,
  hidden,
}: {
  size: PillSize
  liveMode: boolean
  demoTraffic: boolean
  activeFilterCount: number
  canFit: boolean
  canGoToServer: boolean
  onFit(): void
  onGoToServer(): void
  onToggleLive(): void
  /** An `asChild` trigger, such as `<DrawerTrigger asChild />`, that the Layers button goes into. */
  layersTrigger: ReactElement
  hidden: boolean
}) {
  const side = usePhoneMapSide()
  const compact = size === "compact"

  return (
    <nav
      aria-label="Map actions"
      inert={hidden}
      style={{
        width: compact ? PILL_WIDTH_COMPACT : PILL_WIDTH,
        right: side ? `max(${PILL_SIDE_EDGE}px, env(safe-area-inset-right, 0px))` : "var(--tab-bar-side)",
      }}
      className={cn(
        TAB_BAR_SURFACE,
        "absolute bottom-(--tab-bar-clear) z-10 grid gap-0.5 rounded-full border border-foreground/10 p-1",
        hidden && "invisible",
      )}
    >
      <PillButton
        name={activeFilterCount > 0 ? `Layers and filters, ${activeFilterCount} active filter groups` : "Layers and filters"}
        compact={compact}
        wrap={(button) => cloneElement(layersTrigger, undefined, button)}
      >
        <Layers aria-hidden className={PILL_ICON} />
        {activeFilterCount > 0 && (
          <span aria-hidden className="absolute top-[9px] right-[9px] size-[7px] rounded-full bg-primary" />
        )}
      </PillButton>
      {size !== "two" && (
        <>
          <PillButton name={canFit ? "All traffic" : "All traffic: no data yet"} compact={compact} unavailable={!canFit} onClick={onFit}>
            <Focus aria-hidden className={PILL_ICON} />
          </PillButton>
          <PillButton
            name={canGoToServer ? "Server" : "Server: no location"}
            compact={compact}
            unavailable={!canGoToServer}
            onClick={onGoToServer}
          >
            <Server aria-hidden className={PILL_ICON} />
          </PillButton>
        </>
      )}
      <PillButton
        name={demoTraffic ? "Demo traffic" : "Live"}
        compact={compact}
        pressed={liveMode}
        onClick={onToggleLive}
        className={cn(liveMode && LIVE_ON)}
      >
        <Radio aria-hidden className={cn(PILL_ICON, liveMode && "animate-pulse motion-reduce:animate-none")} />
      </PillButton>
    </nav>
  )
}

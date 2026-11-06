import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { MoreHorizontal, type LucideIcon } from "lucide-react"
import { useKeyboardOpen } from "@/hooks/use-keyboard-open"
import { useServiceStatus } from "@/hooks/use-service-status"
import { usePhoneChrome } from "@/lib/phone-chrome"
import { activeTab, barItems, moreBadge, slotFour } from "@/lib/phone-nav"
import { useChangelogUnseen, useCrowdsecStatus, useUnseenRelease } from "@/lib/queries"
import { reloadNoticeTitle, useReloadNotice } from "@/lib/reload-notice"
import { cn } from "@/lib/utils"

type Badge = { tone: "amber" | "accent"; description: string }
type ServiceVariant = ReturnType<typeof useServiceStatus>["variant"]

function useMoreBadge({ variant, tooltip }: { variant: ServiceVariant; tooltip: string }): Badge | null {
  const changelogUnseen = useChangelogUnseen()
  const unseenRelease = useUnseenRelease()
  const reload = useReloadNotice()
  const tone = moreBadge({
    variant,
    changelogUnseen,
    releaseUnseen: unseenRelease !== null,
    reloadPending: reload.pending,
  })
  if (tone === null) return null
  if (tone === "amber") return { tone, description: tooltip }
  const notes = [
    reload.pending ? reloadNoticeTitle(reload.version) : null,
    unseenRelease ? `${unseenRelease.displayVersion} is available` : null,
    changelogUnseen ? "New changes to read in the changelog" : null,
  ]
  return { tone, description: notes.filter(Boolean).join(". ") }
}

function suppressContextMenu(event: MouseEvent) {
  event.preventDefault()
}

const BAR_FRAME = "rounded-full p-1"

const BAR_SURFACE =
  "fixed z-40 bg-card/88 ring-1 ring-foreground/10 shadow-[0_10px_30px_rgb(0_0_0/0.45),inset_0_1px_0_oklch(1_0_0/6%)] backdrop-blur-[14px] backdrop-saturate-[1.4]"

const PORTRAIT_BAR =
  "inset-x-[var(--tab-bar-side)] bottom-[max(12px,calc(env(safe-area-inset-bottom,0px)_-_12px))] grid h-[62px] grid-cols-5"

const COMPACT_BAR =
  "left-[calc(env(safe-area-inset-left,0px)_+_12px)] right-[calc(env(safe-area-inset-right,0px)_+_12px)] bottom-[max(8px,calc(env(safe-area-inset-bottom,0px)_-_4px))] mx-auto flex h-12 w-fit gap-0.5 phone-short:h-11"

const PORTRAIT_CELL = "min-w-0 flex-col justify-center gap-[3px] text-[10.5px]"
const COMPACT_CELL = "gap-[7px] px-3.5 text-[13px] phone-short:px-3 phone-short:text-[12.5px]"
const ICON_CELL = "w-14 justify-center"

function cellClass(layout: "portrait" | "compact" | "icons", selected: boolean): string {
  return cn(
    "relative flex items-center rounded-full font-medium whitespace-nowrap text-foreground outline-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-ring",
    layout === "portrait" ? PORTRAIT_CELL : layout === "compact" ? COMPACT_CELL : ICON_CELL,
    selected && "bg-foreground/9 text-primary",
  )
}

function CellContent({ icon: Icon, label, badge, showLabel }: { icon: LucideIcon; label: string; badge?: Badge["tone"] | null; showLabel: boolean }) {
  return (
    <>
      <span className="relative grid shrink-0">
        <Icon aria-hidden className="size-[22px] phone-side:size-5" />
        {badge && (
          <span
            aria-hidden
            className={cn(
              "absolute -top-0.5 -right-1 size-[7px] rounded-full",
              badge === "amber" ? "bg-amber-400 shadow-[0_0_6px_rgb(245_165_36/0.6)]" : "bg-primary shadow-[0_0_6px_var(--primary)]",
            )}
          />
        )}
      </span>
      {showLabel && <span className="max-w-full truncate">{label}</span>}
    </>
  )
}

/** Whether the labelled compact bar is wider than the room between the insets.
 *  `probe` is an invisible labelled copy of the bar; `bar` gives the room. */
function useLabelsOverflow(compact: boolean, bar: RefObject<HTMLElement | null>, probe: RefObject<HTMLElement | null>): boolean {
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    if (!compact || !bar.current || !probe.current) {
      setOverflow(false)
      return
    }
    const barElement = bar.current
    const probeElement = probe.current
    const measure = () => {
      const style = getComputedStyle(barElement)
      const room = window.innerWidth - parseFloat(style.left) - parseFloat(style.right)
      setOverflow(probeElement.offsetWidth > room)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(probeElement)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [compact, bar, probe])

  return overflow
}

export function TabBar({ compact }: { compact: boolean }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { data: crowdsecStatus, isError } = useCrowdsecStatus()
  const slot = slotFour(crowdsecStatus, isError)
  const items = barItems(slot)
  const current = activeTab(pathname, slot)
  const serviceStatus = useServiceStatus()
  const more = useMoreBadge(serviceStatus)
  const { barCovered, moreOpen, setMoreOpen, moreTriggerRef } = usePhoneChrome()
  const keyboardOpen = useKeyboardOpen()
  const idPrefix = useId()

  const barRef = useRef<HTMLElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const iconsOnly = useLabelsOverflow(compact, barRef, probeRef)
  const layout = !compact ? "portrait" : iconsOnly ? "icons" : "compact"
  const showLabel = layout !== "icons"

  const securityWarning = serviceStatus.crowdsecDown ? "CrowdSec LAPI unreachable" : null
  const descriptions: ReactNode[] = []
  const describe = (key: string, text: string | null) => {
    if (!text) return undefined
    const id = `${idPrefix}-${key}`
    descriptions.push(
      <span key={id} id={id} hidden>
        {text}
      </span>,
    )
    return id
  }

  return (
    <nav
      ref={barRef}
      aria-label="Main"
      data-tab-bar=""
      data-compact={compact ? "" : undefined}
      hidden={barCovered || keyboardOpen}
      className={cn(BAR_FRAME, BAR_SURFACE, compact ? COMPACT_BAR : PORTRAIT_BAR)}
    >
      {items.map((item) => {
        const selected = current === item.id
        const warning = item.id === "security" ? securityWarning : null
        return (
          <Link
            key={item.id}
            to={item.url}
            aria-current={selected ? "page" : undefined}
            aria-label={showLabel ? undefined : item.title}
            aria-describedby={describe(item.id, warning)}
            onContextMenu={suppressContextMenu}
            className={cellClass(layout, selected)}
          >
            <CellContent icon={item.icon} label={item.title} badge={warning ? "amber" : null} showLabel={showLabel} />
          </Link>
        )
      })}
      <button
        ref={moreTriggerRef}
        type="button"
        aria-expanded={moreOpen}
        aria-label={showLabel ? undefined : "More"}
        aria-describedby={describe("more", more?.description ?? null)}
        onClick={() => setMoreOpen(!moreOpen)}
        onContextMenu={suppressContextMenu}
        className={cn(
          cellClass(layout, current === "more"),
          layout === "portrait" && "col-start-5",
          "aria-expanded:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--primary)_60%,transparent)]",
        )}
      >
        <CellContent icon={MoreHorizontal} label="More" badge={more?.tone} showLabel={showLabel} />
      </button>
      {descriptions}
      {compact && (
        <div ref={probeRef} aria-hidden inert className={cn(BAR_FRAME, "invisible absolute top-0 left-0 flex h-12 w-max gap-0.5 phone-short:h-11")}>
          {[...items.map((item) => ({ key: item.id, icon: item.icon, title: item.title })), { key: "more", icon: MoreHorizontal, title: "More" }].map(
            (cell) => (
              <span key={cell.key} className={cellClass("compact", false)}>
                <CellContent icon={cell.icon} label={cell.title} showLabel />
              </span>
            ),
          )}
        </div>
      )}
    </nav>
  )
}

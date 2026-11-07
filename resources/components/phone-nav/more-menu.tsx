import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from "react"
import { createPortal } from "react-dom"
import { Link, useRouterState } from "@tanstack/react-router"
import { ChevronRight, LogOut } from "lucide-react"
import { SiDocker } from "react-icons/si"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ReloadNoticeMenuCard } from "@/components/reload-notice"
import { useServiceStatus } from "@/hooks/use-service-status"
import { logOut } from "@/lib/log-out"
import { useOverlayEntry } from "@/lib/overlay-history"
import { usePhoneChrome } from "@/lib/phone-chrome"
import { moreItems, slotFour } from "@/lib/phone-nav"
import { useChangelogUnseen, useCrowdsecStatus, useMe, useRuntimeSettings, useUnseenRelease } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { containerRuntimeLabel, displayVersion, publicVersion } from "@/lib/version"

function StatusLink() {
  const { variant, color, label, attention, statusRoute } = useServiceStatus()
  const warn = variant === "degraded" || variant === "attention"

  return (
    <Link
      to={statusRoute}
      replace
      className={cn(
        "mx-3.5 my-1.5 flex items-center gap-2.5 rounded-[10px] border px-3 text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        warn ? "min-h-[54px] border-amber-400/35 bg-amber-400/7 py-2" : "h-11 border-border bg-foreground/2",
      )}
    >
      <span aria-hidden className="relative size-2 shrink-0">
        <span className={cn("absolute -inset-1 rounded-full opacity-18", color)} />
        <span className={cn("absolute inset-0 rounded-full", color)} />
      </span>
      {warn ? (
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {attention.length > 0 && <span className="text-xs text-amber-700 dark:text-amber-300">{attention.join(", ")}</span>}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      <ChevronRight aria-hidden className="size-4 shrink-0" />
    </Link>
  )
}

function Destinations({ compact }: { compact: boolean }) {
  const { data: crowdsecStatus, isError } = useCrowdsecStatus()
  const changelogUnseen = useChangelogUnseen()

  return moreItems(slotFour(crowdsecStatus, isError)).map((item) => {
    const Icon = item.icon
    const notice = item.id === "settings" && changelogUnseen
    return (
      <Link
        key={item.id}
        to={item.url}
        replace
        className={cn(
          "flex shrink-0 items-center gap-3.5 px-[18px] text-[15px] outline-none focus-visible:bg-foreground/5 active:bg-foreground/5",
          compact ? "h-11" : "h-[50px]",
        )}
      >
        <span className="relative text-muted-foreground">
          <Icon aria-hidden className="size-5" />
          {notice && <span aria-hidden className="absolute -top-0.5 -right-[3px] size-[7px] rounded-full bg-primary" />}
        </span>
        <span className="min-w-0 flex-1">
          {item.title}
          {notice && <small className="-mt-px block text-[11.5px] text-primary">New in the changelog</small>}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    )
  })
}

function Footer() {
  const { data: settings } = useRuntimeSettings()
  const unseenRelease = useUnseenRelease()
  const { data: me } = useMe()

  return (
    <div className="flex shrink-0 items-center justify-between px-[18px] pt-1.5 pb-2.5 font-mono text-[11px] text-muted-foreground">
      <span className="flex h-11 items-center gap-1.5">
        {settings && displayVersion(publicVersion(settings.version))}
        {settings?.runtime.container && (
          <span role="img" aria-label={containerRuntimeLabel(settings.runtime.imageTag)} className="inline-flex">
            <SiDocker aria-hidden className="size-4 text-[#2496ED]" />
          </span>
        )}
        {unseenRelease && (
          <Link to="/settings/about" replace className="font-sans text-xs font-medium text-primary">
            {unseenRelease.displayVersion} available
          </Link>
        )}
      </span>
      {me?.mode === "session" && (
        <button
          type="button"
          onClick={logOut}
          className="flex h-11 items-center gap-2 rounded-[10px] px-3 font-sans text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/5"
        >
          <LogOut aria-hidden className="size-5" />
          Log out
        </button>
      )}
    </div>
  )
}

export function MoreContent({ compact }: { compact: boolean }) {
  const { setMoreOpen } = usePhoneChrome()
  const cards = (
    <>
      <StatusLink />
      <ReloadNoticeMenuCard stacked={compact} onLater={() => setMoreOpen(false)} />
    </>
  )

  if (!compact) {
    return (
      <div className="flex min-h-0 flex-col overflow-y-auto pb-2">
        {cards}
        <Destinations compact={false} />
        <Footer />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-[290px] shrink-0 overflow-y-auto border-r pt-1.5">{cards}</div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pt-1.5">
        <Destinations compact />
        <Footer />
      </div>
    </div>
  )
}

type SafeAreaInsets = { top: number; left: number; right: number }

function readSafeAreaInsets(): SafeAreaInsets {
  const probe = document.createElement("div")
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) 0 env(safe-area-inset-left,0px)"
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const insets = {
    top: parseFloat(style.paddingTop) || 0,
    left: parseFloat(style.paddingLeft) || 0,
    right: parseFloat(style.paddingRight) || 0,
  }
  probe.remove()
  return insets
}

/** The phone tab bar's More menu, opened by `trigger`, the bar's More cell. */
export function MoreMenu({ compact, trigger }: { compact: boolean; trigger: ReactElement }) {
  const { moreOpen, setMoreOpen, moreTriggerRef } = usePhoneChrome()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const openedOn = useRef(pathname)
  const leaving = useRef(false)
  const scrimRef = useRef<HTMLDivElement>(null)
  const [insets, setInsets] = useState<SafeAreaInsets>({ top: 0, left: 0, right: 0 })

  useEffect(() => setMoreOpen(false), [pathname, setMoreOpen])
  // A layout effect, so the menu of the old layout never paints in the new one.
  useLayoutEffect(() => setMoreOpen(false), [compact, setMoreOpen])
  useEffect(() => () => setMoreOpen(false), [setMoreOpen])
  useOverlayEntry("more", moreOpen, () => setMoreOpen(false))

  function changeOpen(open: boolean) {
    if (open) {
      openedOn.current = pathname
      leaving.current = false
      if (compact) setInsets(readSafeAreaInsets())
    }
    setMoreOpen(open)
  }

  // A link to the current page doesn't change the path, so it closes More itself.
  function closeOnLink(event: MouseEvent) {
    if (!(event.target as Element).closest("a[href]")) return
    leaving.current = true
    setMoreOpen(false)
  }

  function onCloseAutoFocus(event: Event) {
    event.preventDefault()
    if (!leaving.current && pathname === openedOn.current) moreTriggerRef.current?.focus()
  }

  const content = (
    <div className="contents" onClick={closeOnLink}>
      <MoreContent compact={compact} />
    </div>
  )

  if (!compact) {
    return (
      <Drawer open={moreOpen} onOpenChange={changeOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
          <DrawerTitle className="sr-only">More</DrawerTitle>
          {content}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={moreOpen} onOpenChange={changeOpen} modal={false}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        aria-label="More"
        side="top"
        align="end"
        // The anchor is the More cell, inset 4px in the bar's padding; these put
        // the popover 8px above the bar and flush with its right edge.
        sideOffset={12}
        alignOffset={-4}
        collisionPadding={{ top: Math.max(8, insets.top), left: Math.max(8, insets.left), right: Math.max(8, insets.right) }}
        onInteractOutside={(event) => {
          const target = event.target as Element | null
          if (target?.closest("[data-tab-bar]")) {
            // A bar tab to another page replaces More's history entry, so More stays open
            // until the navigation closes it. The current page's tab closes More itself.
            if (target.closest('a[href]:not([aria-current="page"])')) event.preventDefault()
            return
          }
          if (target === scrimRef.current) event.preventDefault()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        className="h-(--radix-popover-content-available-height) w-[min(620px,calc(100vw_-_16px_-_env(safe-area-inset-left,0px)_-_env(safe-area-inset-right,0px)))] flex-row gap-0 overflow-hidden rounded-[14px] bg-background p-0 text-foreground shadow-[0_20px_40px_rgb(0_0_0/0.5)] ring-border"
      >
        {content}
      </PopoverContent>
      {moreOpen &&
        createPortal(
          <div
            ref={scrimRef}
            aria-hidden
            onClick={() => setMoreOpen(false)}
            className="fixed inset-0 z-[35] bg-black/50 animate-in fade-in-0"
          />,
          document.body,
        )}
    </Popover>
  )
}

import { useEffect } from "react"
import type { MouseEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSidebar } from "@/components/ui/sidebar"
import { isMobileViewport } from "@/hooks/use-mobile"
import {
  claimReloadToast,
  closeReloadToast,
  reloadNoticeTitle,
  reloadNoticeTooltip,
  reloadToastMessage,
  useReloadNotice,
} from "@/lib/reload-notice"
import { loadNow, reloadNow, useUpdateDetector } from "@/lib/use-update-detector"

const CHANGELOG_HREF = "/settings/changelog"
const RELOAD_TOAST_ID = "reload-notice"

function ReloadToastMessage() {
  const { version } = useReloadNotice()
  return <>{reloadToastMessage(version)}</>
}

export function ReloadNotice(): null {
  const { pending } = useReloadNotice()
  useUpdateDetector()

  useEffect(() => {
    if (!pending || !isMobileViewport() || !claimReloadToast()) return
    // sonner's Cancel button does not call onDismiss, so both handlers close the toast state.
    toast(<ReloadToastMessage />, {
      id: RELOAD_TOAST_ID,
      duration: Infinity,
      cancel: { label: "Later", onClick: closeReloadToast },
      action: { label: "Reload", onClick: reloadNow },
      onDismiss: closeReloadToast,
    })
  }, [pending])

  return null
}

function openChangelog(clickEvent: MouseEvent<HTMLAnchorElement>) {
  if (clickEvent.button !== 0 || clickEvent.metaKey || clickEvent.ctrlKey || clickEvent.shiftKey || clickEvent.altKey) return
  clickEvent.preventDefault()
  loadNow(CHANGELOG_HREF)
}

function GlowDot() {
  return <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]" />
}

export function ReloadNoticeCard() {
  const { version } = useReloadNotice()

  return (
    <Card
      size="sm"
      className="bg-primary/5 text-sidebar-foreground shadow-none ring-primary/30 data-[size=sm]:gap-2 data-[size=sm]:py-2.5"
    >
      <CardContent className="flex flex-col gap-2 group-data-[size=sm]/card:px-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <GlowDot />
          <span className="truncate">{reloadNoticeTitle(version)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="xs" onClick={reloadNow}>
            Reload
          </Button>
          <Button size="xs" variant="link" asChild>
            <a href={CHANGELOG_HREF} onClick={openChangelog}>
              What's new
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function ReloadNoticeCollapsedButton() {
  const { version } = useReloadNotice()
  const tooltip = reloadNoticeTooltip(version)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="mx-auto" aria-label={tooltip} onClick={reloadNow}>
          <GlowDot />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span>{tooltip}</span>
      </TooltipContent>
    </Tooltip>
  )
}

export const RELOAD_NOTICE_MENU_DESCRIPTION_ID = "reload-notice-menu-description"

export function ReloadNoticeMenuDot() {
  const { pending, version, toastOpen } = useReloadNotice()
  const { isMobile } = useSidebar()
  if (!pending || toastOpen || !isMobile) return null

  return (
    <>
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]"
      />
      <span id={RELOAD_NOTICE_MENU_DESCRIPTION_ID} className="sr-only">
        {reloadNoticeTitle(version)}
      </span>
    </>
  )
}

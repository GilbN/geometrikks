import type { MouseEvent } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { reloadNoticeTitle, reloadNoticeTooltip, useReloadNotice } from "@/lib/reload-notice"
import { loadNow, reloadNow, useUpdateDetector } from "@/lib/use-update-detector"

const CHANGELOG_HREF = "/settings/changelog"

export function ReloadNotice(): null {
  useUpdateDetector()
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

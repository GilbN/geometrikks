import { ArrowLeft, Eye, Settings } from "lucide-react"
import { BadgeHint } from "@/components/badge-hint"
import { BrandMark } from "@/components/brand/brand-mark"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { realChrome } from "../lib/chrome-api"

export type ServerHealth = "ok" | "bad" | "checking"

export function Header({
  host,
  health,
  readOnly = false,
  title = "GeoMetrikks",
  onBack,
}: {
  host: string | null
  health: ServerHealth
  readOnly?: boolean
  title?: string
  /** Shows a back arrow in place of the mark, as the lookup does. */
  onBack?: () => void
}) {
  return (
    <header className="flex items-center gap-2 border-b bg-sidebar px-3 py-2.5">
      {onBack ? (
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}>
          <ArrowLeft />
        </Button>
      ) : (
        <BrandMark size={18} variant="small" decorative />
      )}
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {readOnly && (
          <BadgeHint hint="Ban and unban need a Read/write key">
            <Badge
              variant="outline"
              className="h-auto rounded-full px-1.5 py-px text-[10.5px] font-normal text-muted-foreground"
            >
              <Eye />
              Read only
            </Badge>
          </BadgeHint>
        )}
        {host && (
          <>
            <span
              className={cn(
                "size-[7px] shrink-0 rounded-full",
                health === "ok" && "bg-chart-2",
                health === "bad" && "bg-destructive",
                health === "checking" && "bg-muted-foreground/40",
              )}
              role="img"
              aria-label={
                health === "ok" ? "Connected" : health === "bad" ? "Not working" : "Checking"
              }
            />
            <span className="truncate">{host}</span>
          </>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label="Options"
        title="Options"
        onClick={() => void realChrome.runtime.openOptionsPage()}
      >
        <Settings />
      </Button>
    </header>
  )
}

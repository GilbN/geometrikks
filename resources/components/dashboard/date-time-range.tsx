import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { Clock } from "lucide-react"

// Visible text is browser-local like the rest of the UI; the hover tooltip
// keeps the full UTC instant for correlating with logs and the API.
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

const DATE_ONLY = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
})

const TIME_ONLY = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

/** Short local zone label for the badge, e.g. "GMT+2" or "CEST". */
const ZONE_LABEL =
  new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? ""

const fullFormat = (d: Date) => d.toUTCString()

export function DateTimeRange({ start, end }: { start: string; end: string }) {
  const startDate = new Date(start)
  const endDate = new Date(end)

  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate()

  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground shadow-inner">
      <Clock className="h-4 w-4 text-geo-cyan" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span suppressHydrationWarning className="cursor-default font-mono">
            {sameDay ? DATE_ONLY.format(startDate) : DATE_TIME.format(startDate)}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{fullFormat(startDate)}</p>
        </TooltipContent>
      </Tooltip>

      {sameDay && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
                <span suppressHydrationWarning className="cursor-default font-mono">
                  {TIME_ONLY.format(startDate)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(startDate)}</p>
            </TooltipContent>
          </Tooltip>
            <span className="text-muted-foreground/60">→</span>
            <Tooltip>
            <TooltipTrigger asChild>
              <span suppressHydrationWarning className="cursor-default font-mono">
                  {TIME_ONLY.format(endDate)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(endDate)}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {!sameDay && (
        <>
          <span className="text-muted-foreground/60">→</span>
          <Tooltip>
            <TooltipTrigger asChild>
                <span suppressHydrationWarning className="cursor-default font-mono">
                {DATE_TIME.format(endDate)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(endDate)}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}
      {ZONE_LABEL && (
        <span className="ml-1 text-[10px] font-bold text-muted-foreground/80">
          {ZONE_LABEL}
        </span>
      )}
    </div>
  )
}

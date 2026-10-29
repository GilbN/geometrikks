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

/** Date and time, or the date alone below md so the band fits on one line. */
function DateTime({ date }: { date: Date }) {
  return (
    <>
      <span className="md:hidden">{DATE_ONLY.format(date)}</span>
      <span className="max-md:hidden">{DATE_TIME.format(date)}</span>
    </>
  )
}

export function DateTimeRange({ start, end }: { start: string; end: string }) {
  const startDate = new Date(start)
  const endDate = new Date(end)

  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate()

  return (
    <div className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md *:whitespace-nowrap bg-muted/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground shadow-inner">
      <Clock className="h-4 w-4 text-primary" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span suppressHydrationWarning className="cursor-default font-mono">
            {sameDay ? DATE_ONLY.format(startDate) : <DateTime date={startDate} />}
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
                <DateTime date={endDate} />
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

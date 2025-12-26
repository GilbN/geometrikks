import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { Clock } from "lucide-react"

export function DateTimeRange({ start, end }: { start: string; end: string }) {
  const startDate = new Date(start)
  const endDate = new Date(end)

  const formatOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }

  const formatTime = (d: Date) => {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    })
  }

  const formatDate = (d: Date) => {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    })
  }
  
  const fullFormat = (d: Date) => d.toUTCString();


  const sameDay =
    startDate.getUTCFullYear() === endDate.getUTCFullYear() &&
    startDate.getUTCMonth() === endDate.getUTCMonth() &&
    startDate.getUTCDate() === endDate.getUTCDate()

  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground shadow-inner">
      <Clock className="h-4 w-4 text-geo-cyan" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span suppressHydrationWarning className="cursor-default font-mono">
            {sameDay
              ? formatDate(startDate)
              : startDate.toLocaleString(undefined, formatOptions)}
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
                  {formatTime(startDate)}
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
                  {formatTime(endDate)}
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
                {endDate.toLocaleString(undefined, formatOptions)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(endDate)}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}
      <span className="ml-1 text-[10px] font-bold text-muted-foreground/80">
        UTC
      </span>
    </div>
  )
}

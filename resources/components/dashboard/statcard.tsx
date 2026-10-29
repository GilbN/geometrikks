import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

import { TrendingUp, TrendingDown, Minus } from "lucide-react"
import { formatPercent } from "@/lib/api"
import { FLAT_DELTA_LABEL, deltaDirection, deltaTone } from "@/lib/stat-delta"
import { cn } from "@/lib/utils"

/**
 * The grid for a row of stat cards. Below md the cards sit two to a row and
 * an odd last card takes the whole row; `className` sets the wider columns.
 */
export function StatGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 md:gap-4 max-md:[&>:last-child:nth-child(odd)]:col-span-2",
        className
      )}
    >
      {children}
    </div>
  )
}

// A two-row subgrid of the StatGrid, so titles and values line up across a
// row when one title wraps onto more lines than its neighbours.
const CARD_CLASS = "relative row-span-2 grid grid-cols-[minmax(0,1fr)] grid-rows-subgrid overflow-hidden gap-1.5 py-3 md:gap-6 md:py-4"
const HEADER_CLASS = "flex flex-row items-center justify-between px-3 md:px-6 md:pb-2"
const CONTENT_CLASS = "px-3 md:px-6"

export function StatCardSkeleton() {
  return (
    <Card className={CARD_CLASS}>
      <CardHeader className={HEADER_CLASS}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-4 rounded" />
      </CardHeader>
      <CardContent className={CONTENT_CLASS}>
        <Skeleton className="mb-2 h-7 w-24 md:h-8 md:w-32" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  )
}

const TONE_CLASS = {
  accent: "text-primary",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const

const DIRECTION_ICON = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
} as const

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  valueClassName,
  iconClassName,
}: {
  title: string
  value: string
  subtitle: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  trend?: { value: number | null; positive?: boolean }
  valueClassName?: string
  iconClassName?: string
}) {
  const deltaValue = trend?.value
  const tone = deltaTone(deltaValue, trend?.positive)

  return (
    <Card className={CARD_CLASS}>
      <CardHeader className={HEADER_CLASS}>
        <CardTitle className="min-w-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className={cn("h-4 w-4 shrink-0 text-primary", iconClassName)} />
      </CardHeader>
      <CardContent className={CONTENT_CLASS}>
        <div
          className={cn(
            "text-2xl font-semibold tracking-tight tabular-nums",
            valueClassName
          )}
        >
          {value}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-xs text-muted-foreground">{subtitle}</span>
          {tone !== null && deltaValue != null && (
            <DeltaBadge value={deltaValue} tone={tone} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DeltaBadge({
  value,
  tone,
}: {
  value: number
  tone: "accent" | "destructive" | "muted"
}) {
  const direction = deltaDirection(value)
  const DirectionIcon = DIRECTION_ICON[direction]
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 text-xs font-medium tabular-nums",
        TONE_CLASS[tone]
      )}
    >
      <DirectionIcon className="h-3 w-3" />
      {direction === "flat" ? FLAT_DELTA_LABEL : formatPercent(value)}
    </span>
  )
}

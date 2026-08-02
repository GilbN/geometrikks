import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

import { TrendingUp, TrendingDown, Minus } from "lucide-react"
import { formatPercent } from "@/lib/api"
import { deltaDirection, deltaTone } from "@/lib/stat-delta"
import { cn } from "@/lib/utils"

export function StatCardSkeleton() {
  return (
    <Card className="relative overflow-hidden py-4">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-4 rounded" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-32 mb-2" />
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
  const tone = deltaTone(trend?.value, trend?.positive)

  return (
    <Card className="relative overflow-hidden py-4">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className={cn("h-4 w-4 text-primary", iconClassName)} />
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-2xl font-semibold tracking-tight tabular-nums",
            valueClassName
          )}
        >
          {value}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">{subtitle}</span>
          {tone !== null && (
            <DeltaBadge value={trend!.value as number} tone={tone} />
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
  const DirectionIcon = DIRECTION_ICON[deltaDirection(value)]
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 text-xs font-medium tabular-nums",
        TONE_CLASS[tone]
      )}
    >
      <DirectionIcon className="h-3 w-3" />
      {formatPercent(value)}
    </span>
  )
}

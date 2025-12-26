import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

import { TrendingUp, TrendingDown } from "lucide-react"
import { formatPercent } from "@/lib/api"
import { cn } from "@/lib/utils"


export function StatCardSkeleton() {
  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4 rounded" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-32 mb-2" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  )
}

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
}: {
  title: string
  value: string
  subtitle: string
  icon: React.ComponentType<{ className?: string }>
  trend?: { value: number | null; positive?: boolean }
}) {
  const hasTrend = trend?.value !== null && trend?.value !== undefined
  const isPositive = trend?.positive ?? (trend?.value ?? 0) >= 0

  return (
    <Card className="relative overflow-hidden">
      {/* <div className="absolute top-0 right-0 w-24 h-24 bg-geo-cyan/5 rounded-full -translate-y-8 translate-x-8" /> */}
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-geo-cyan" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">{subtitle}</span>
          {hasTrend && (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                isPositive ? "text-emerald-500" : "text-red-500"
              )}
            >
              {isPositive ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {formatPercent(trend.value)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

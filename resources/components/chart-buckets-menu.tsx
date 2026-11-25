/**
 * Chart buckets: Auto, Hourly or Daily for every chart on the page. On a
 * phone the range drawer holds this choice, so these menus are for wider
 * layouts only.
 */
import { ChevronDown } from "lucide-react"

import { BadgeHint } from "@/components/badge-hint"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { CHART_GRANULARITY_OPTIONS, type ChartGranularity } from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"

function BucketChoices() {
  const { granularity, setGranularity } = useTimeRange()
  return (
    <DropdownMenuContent align="end" className="min-w-36">
      <DropdownMenuLabel className="text-xs text-muted-foreground">Chart buckets</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={granularity}
        onValueChange={(value) => setGranularity(value as ChartGranularity)}
      >
        {CHART_GRANULARITY_OPTIONS.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value} className="text-[13px]">
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  )
}

/** "Buckets: Auto", beside a page's Charts switch. */
export function ChartBucketsMenu() {
  const { granularity } = useTimeRange()
  const phone = usePhoneLayout()
  if (phone) return null
  const label = CHART_GRANULARITY_OPTIONS.find((option) => option.value === granularity)?.label
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px]">
          <span className="text-muted-foreground">Buckets</span>
          {label}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <BucketChoices />
    </DropdownMenu>
  )
}

const BADGE =
  "rounded-md border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"

function bucketLabel(granularity: string): string {
  return granularity === "hourly" ? "Hourly" : granularity === "daily" ? "Daily" : granularity
}

/** The bucket size a chart's data came back in. It opens the bucket menu. */
export function GranularityBadge({ granularity }: { granularity: string | undefined }) {
  const phone = usePhoneLayout()
  const { granularity: choice } = useTimeRange()
  if (!granularity) return null
  const label = bucketLabel(granularity)
  if (phone) {
    return (
      <BadgeHint hint="Bucket size chosen for the selected range">
        <span className={BADGE}>{label}</span>
      </BadgeHint>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`${BADGE} inline-flex items-center gap-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
        aria-label={`Chart buckets: ${choice === "auto" ? `Auto, ${label}` : label}`}
      >
        {label}
        <ChevronDown aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <BucketChoices />
    </DropdownMenu>
  )
}

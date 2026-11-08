import { Switch } from "@/components/ui/switch"
import { useCardCharts, type CardChartsPage } from "@/lib/card-charts"

/** The page header's Charts switch. Phones set it in the range drawer instead. */
export function CardChartsSwitch({ page }: { page: CardChartsPage }) {
  const [chartsOn, setChartsOn] = useCardCharts(page)
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground phone:hidden">
      <Switch size="sm" checked={chartsOn} onCheckedChange={setChartsOn} />
      Charts
    </label>
  )
}

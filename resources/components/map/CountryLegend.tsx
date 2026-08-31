/** Choropleth break legend; bottom-left overlay, countries mode only. */
import { formatNumber } from "@/lib/api"

export function CountryLegend({
  breaks,
  steps,
  noData,
}: {
  breaks: number[]
  steps: string[]
  noData: string
}) {
  return (
    <div className="absolute bottom-8 left-2 z-10 rounded-md border bg-background/85 px-2.5 py-2 text-xs backdrop-blur">
      <div className="mb-1 font-medium text-muted-foreground">Requests</div>
      <div className="flex items-center gap-1">
        {steps.map((color, i) => (
          <div key={color} className="flex flex-col items-center gap-0.5">
            <span className="h-2.5 w-7 rounded-sm" style={{ backgroundColor: color }} />
            <span className="text-[10px] text-muted-foreground">{formatNumber(breaks[i])}</span>
          </div>
        ))}
        <div className="ml-1.5 flex flex-col items-center gap-0.5">
          <span className="h-2.5 w-7 rounded-sm" style={{ backgroundColor: noData }} />
          <span className="text-[10px] text-muted-foreground">none</span>
        </div>
      </div>
    </div>
  )
}

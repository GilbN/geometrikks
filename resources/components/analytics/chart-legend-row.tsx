import type { ChartConfig } from "@/components/ui/chart"

/** Footer legend for a SignalPanel: one dot and label per series in `config`. */
export function ChartLegendRow({ config, label }: { config: ChartConfig; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label={label}>
      {Object.entries(config).map(([key, item]) => (
        <span key={key} className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

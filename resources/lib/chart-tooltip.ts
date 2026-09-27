/** A tooltip row built by hand instead of by Recharts (the latency band). */
export type TooltipRow = {
  dataKey: string
  name: string
  value: number | null
  color?: string
  payload: unknown
}

type PayloadItem = { dataKey?: unknown; value?: unknown; payload?: unknown }

/**
 * Log mode draws zeros at the axis minimum; the rows keep the real values in
 * `raw`. Put those back so the tooltip reads 0, not the floor.
 */
export function withRawValues<T extends PayloadItem>(items: T[] | undefined): T[] | undefined {
  return items?.map((item) => {
    const raw = (item.payload as { raw?: Record<string, unknown> } | undefined)?.raw
    return typeof item.dataKey === "string" && raw && item.dataKey in raw
      ? ({ ...item, value: raw[item.dataKey] } as T)
      : item
  })
}

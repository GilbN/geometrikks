/**
 * The legend with values in a traffic chart's header. It shows totals for the
 * range at rest and the cursor's bucket while one is marked. On a phone the
 * first entry shares a line with the bucket's time and the rest sit in two
 * columns under it.
 */
import { useMemo } from "react"
import { formatTs } from "@/lib/datetime"
import { useCursorBucket, type ChartCursor } from "./chart-cursor"

export type ReadoutItem = {
  key: string
  label: string
  /** Label on a phone, such as "2xx" for "2xx Success". */
  short?: string
  color: string
  /** Leave out to show the label alone. */
  value?: string | null
}

/** The row under the cursor, or null at rest. */
export function useCursorRow<T extends { timestamp: string }>(
  cursor: ChartCursor,
  rows: readonly T[],
): T | null {
  const bucket = useCursorBucket(cursor)
  return useMemo(
    () =>
      bucket == null ? null : (rows.find((row) => Date.parse(row.timestamp) === bucket) ?? null),
    [bucket, rows],
  )
}

function Item({ item }: { item: ReadoutItem }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-[7px] whitespace-nowrap">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: item.color }}
      />
      {item.short ? (
        <>
          <span className="max-md:hidden">{item.label}</span>
          <span className="md:hidden">{item.short}</span>
        </>
      ) : (
        item.label
      )}
      {item.value != null && <b className="font-semibold text-foreground">{item.value}</b>}
    </span>
  )
}

/** The cursor bucket's time, for the header's first line on desktop. */
export function CursorStamp({
  cursor,
  granularity,
}: {
  cursor: ChartCursor
  granularity?: string
}) {
  const bucket = useCursorBucket(cursor)
  if (bucket == null) return null
  return (
    <span className="text-xs font-medium whitespace-nowrap text-foreground tabular-nums max-md:hidden">
      {formatTs(bucket, granularity)}
    </span>
  )
}

export function ChartReadout({
  lead,
  items,
  stamp,
}: {
  /** Text before the legend, such as "39,144 requests". */
  lead?: React.ReactNode
  items: readonly ReadoutItem[]
  /** The cursor bucket's time; a phone shows it at the end of the first line. */
  stamp?: string | null
}) {
  const [first, ...rest] = lead == null ? items : [null, ...items]
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[18px] gap-y-1 text-[13px] text-muted-foreground tabular-nums max-md:gap-x-3.5">
      {lead != null ? (
        <span className="whitespace-nowrap">{lead}</span>
      ) : (
        first && <Item item={first} />
      )}
      {stamp && (
        <span className="ml-auto text-xs font-medium whitespace-nowrap text-foreground md:hidden">
          {stamp}
        </span>
      )}
      {rest.length > 0 && (
        <div className="max-md:grid max-md:basis-full max-md:grid-cols-2 max-md:gap-x-3.5 max-md:gap-y-1 md:contents">
          {rest.map((item) => item && <Item key={item.key} item={item} />)}
        </div>
      )}
    </div>
  )
}

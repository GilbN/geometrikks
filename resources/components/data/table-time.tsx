import { formatClock24, formatDay, fullTimestamp, type TimeFormat } from "@/lib/table-view"

/** A wide table's timestamp. The 24-hour form dims the day so the clock reads first. */
export function TableTime({ value, format }: { value: string; format: TimeFormat }) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">-</span>
  return (
    <span
      className="whitespace-nowrap tabular-nums text-muted-foreground"
      title={fullTimestamp(date)}
    >
      {format === "short24" ? (
        <>
          {formatDay(date, new Date())}{" "}
          <span className="text-foreground">{formatClock24(date)}</span>
        </>
      ) : (
        date.toLocaleString()
      )}
    </span>
  )
}

import { Info } from "lucide-react"

function joinList(items: string[]): string {
  if (items.length < 2) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

export function MutedRetentionNote({ items, days }: { items: string[]; days: number }) {
  if (items.length === 0) return null
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Info aria-hidden className="size-3.5 shrink-0" />
      <span>
        Muted IPs are hidden, so {joinList(items)} only {items.length === 1 ? "covers" : "cover"}{" "}
        the last {days} days.
      </span>
    </p>
  )
}

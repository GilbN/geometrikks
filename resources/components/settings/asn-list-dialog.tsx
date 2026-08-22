/**
 * Searchable viewer for the vendored hosting-ASN list, opened from the
 * About page. Fetched lazily on first open and cached for the session;
 * the list only changes with a release.
 */
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useAsnClassification } from "@/lib/queries"

export function AsnListDialog() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const { data, isLoading, isError } = useAsnClassification(open)

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (!q) return data.entries
    return data.entries.filter(
      (entry) =>
        entry.entity.toLowerCase().includes(q) ||
        String(entry.asn).includes(q) ||
        `as${entry.asn}`.startsWith(q),
    )
  }, [data, query])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="pointer-coarse:h-10">
          Browse list
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Hosting ASN list</DialogTitle>
          <DialogDescription>
            Networks on this list are badged Hosting in analytics; everything
            else shows as Other.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by organization or AS number"
          aria-label="Search the hosting ASN list"
        />
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError || !data ? (
          <p className="text-sm text-destructive">Failed to load the list.</p>
        ) : (
          <>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border/40">
              {filtered.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No entries match &quot;{query}&quot;.
                </p>
              ) : (
                filtered.map((entry) => (
                  <div
                    key={entry.asn}
                    className="flex items-baseline gap-3 border-b border-border/40 px-3 py-1.5 text-sm last:border-0"
                  >
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                      AS{entry.asn}
                    </span>
                    <span className="truncate" title={entry.entity}>
                      {entry.entity || "Unknown"}
                    </span>
                  </div>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {filtered.length} of {data.entries.length} entries
              {query.trim() ? " match" : ""} · {data.dataset} ({data.license})
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

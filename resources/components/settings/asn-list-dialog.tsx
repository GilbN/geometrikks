/**
 * Searchable viewer for the vendored hosting-ASN list, opened from the
 * About page. Fetched lazily on first open and cached for the session;
 * the list only changes with a release.
 */
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { focusDrawerTitle } from "@/components/settings/api-keys-phone"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAsnClassification } from "@/lib/queries"
import { cn } from "@/lib/utils"

const TITLE = "Hosting ASN list"
const DESCRIPTION = "Networks on this list are badged Hosting in analytics; everything else shows as Other."

export function AsnListDialog() {
  const isMobile = useIsMobile()
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

  // See ResponsiveRadioMenu: don't reopen after a rotation to wide and back.
  useEffect(() => {
    if (!isMobile) setOpen(false)
  }, [isMobile])

  const trigger = (
    <Button variant="outline" size="sm">
      Browse list
    </Button>
  )
  const body = (
    <>
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
          <div
            className={cn(
              "overflow-y-auto overscroll-contain rounded-md border border-border/40",
              isMobile ? "min-h-0 flex-1" : "max-h-[50vh]",
            )}
          >
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
                  <span className="min-w-0 break-words">
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
    </>
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen} autoFocus>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="h-[85dvh]" onOpenAutoFocus={focusDrawerTitle}>
          <DrawerHeader>
            <DrawerTitle tabIndex={-1} className="outline-none">
              {TITLE}
            </DrawerTitle>
            <DrawerDescription>{DESCRIPTION}</DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">{body}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription>{DESCRIPTION}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}

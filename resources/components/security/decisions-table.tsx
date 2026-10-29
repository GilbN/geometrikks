/**
 * Active-decisions table: who is banned, why, and, the part no generic
 * CrowdSec dashboard can show, whether that IP appears in this server's own
 * traffic ("Seen 24h" from the enrichment join). Server-paginated against
 * /crowdsec/decisions, one row per target; origin scope toggles between
 * local and crowd bans.
 */
import { useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { isValidBanTarget } from "@/lib/crowdsec"
import { useCrowdsecDecisions, useCrowdsecStatus } from "@/lib/queries"
import { DecisionAlertSheet, type DecisionRef } from "./alert-detail-sheet"
import { BanIpButton } from "./ban-ip-dialog"
import { DecisionGroupRows } from "./decision-group-rows"

const PAGE_SIZES = [10, 25, 50, 100] as const

const ORIGIN_SCOPES = [
  // undefined origins -> the server's local-origins default
  { key: "local", label: "Local", origins: undefined },
  { key: "all", label: "All origins", origins: "crowdsec,cscli,geometrikks,CAPI,lists" },
  { key: "capi", label: "Crowd (CAPI)", origins: "CAPI,lists" },
] as const

type OriginScopeKey = (typeof ORIGIN_SCOPES)[number]["key"]

export function DecisionsTable() {
  const { data: status } = useCrowdsecStatus()
  const [scope, setScope] = useState<OriginScopeKey>("local")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(10)
  const origins = ORIGIN_SCOPES.find((s) => s.key === scope)?.origins
  const [searchInput, setSearchInput] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const q = useDebouncedValue(searchInput.trim())
  // The server searches every origin for an IP or a range, whatever the tab.
  const searchesEveryOrigin = q !== "" && isValidBanTarget(q)
  const [searchedFor, setSearchedFor] = useState(q)
  if (searchedFor !== q) {
    setSearchedFor(q)
    setPage(1)
  }

  const { data, isLoading, isError, isPlaceholderData } = useCrowdsecDecisions({
    // The server ignores the tab for an IP or range search; leaving it out
    // of the key keeps a tab switch from refetching the same answer.
    origins: searchesEveryOrigin ? undefined : origins,
    q: q || undefined,
    currentPage: page,
    pageSize,
  })
  const [selected, setSelected] = useState<DecisionRef | null>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()

  const total = data?.total ?? 0
  const singleMatch = searchesEveryOrigin && total === 1 && !isPlaceholderData
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = narrow ? 1 : status?.writeEnabled ? 9 : 8

  return (
    <Card ref={layoutRef} className="py-4 max-md:gap-0 max-md:pt-3">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-2 max-md:pb-2.5">
        <CardTitle className="mr-auto text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Active decisions</CardTitle>
        {/* One element on every width, so rotating a phone keeps an open Ban IP
            dialog. Phones push the tabs below it and keep it on the title line. */}
        {status?.writeEnabled && <BanIpButton />}
        <div className="flex flex-wrap items-center gap-2 max-md:basis-full">
          <Tabs
            value={scope}
            onValueChange={(value) => {
              setScope(value as OriginScopeKey)
              setPage(1)
            }}
          >
            <TabsList>
              {ORIGIN_SCOPES.map((s) => (
                <TabsTrigger key={s.key} value={s.key}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <div className="px-6 pb-2">
        <div className="relative sm:max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="IP, range or scenario"
            aria-label="Search active decisions"
            aria-describedby={searchesEveryOrigin ? "decision-search-scope" : undefined}
            maxLength={200}
            className="pl-8 pr-9 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
          />
          {searchInput !== "" && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-label="Clear search"
              onClick={() => {
                setSearchInput("")
                // The button goes away with the text, so focus goes back to the field.
                searchRef.current?.focus()
              }}
            >
              <X />
            </Button>
          )}
        </div>
        {/* Always displayed: a live region that appears with its text may not be announced. */}
        <p id="decision-search-scope" aria-live="polite" className="mt-1.5 min-h-4 text-xs text-muted-foreground">
          {searchesEveryOrigin ? "Searching every origin, crowd included." : ""}
        </p>
      </div>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <Table className={narrow ? "table-fixed" : undefined}>
            {!narrow && (
              <TableHeader>
                <TableRow>
                  <TableHead>IP / value</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead>Scenario</TableHead>
                  <TableHead>Expires in</TableHead>
                  <TableHead className="text-right">Seen 24h</TableHead>
                  {status?.writeEnabled && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              {isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      {narrow ? (
                        <TableCell className="space-y-2 py-3">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-3 w-1/2" />
                        </TableCell>
                      ) : (
                        Array.from({ length: colCount }).map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                        ))
                      )}
                    </TableRow>
                  ))
                : data?.items.map((group) => (
                    <DecisionGroupRows
                      // A row that becomes the single match of an IP search remounts open.
                      key={`${group.scope}:${group.ip}:${singleMatch ? "open" : ""}`}
                      defaultOpen={singleMatch}
                      group={group}
                      writeEnabled={status?.writeEnabled === true}
                      dimmed={isPlaceholderData}
                      narrow={narrow}
                      onOpenAlert={setSelected}
                    />
                  ))}
              {!isLoading && isError && !data && (
                <TableRow>
                  <TableCell
                    colSpan={colCount}
                    className="h-24 text-center text-destructive"
                  >
                    Failed to load decisions; the CrowdSec LAPI may be unreachable.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && !isPlaceholderData && total === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={colCount}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {q ? `No active decisions match "${q}".` : "No active decisions for this origin scope."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <PaginationFooter
          page={page}
          pageCount={pageCount}
          total={total}
          onPageChange={setPage}
          // The counts belong to the last answer until the new one lands.
          disabled={isPlaceholderData}
          pageSize={pageSize}
          pageSizes={[...PAGE_SIZES]}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
        />
      </CardContent>
      <DecisionAlertSheet decision={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </Card>
  )
}

/**
 * Active-decisions table: who is banned, why, and, the part no generic
 * CrowdSec dashboard can show, whether that IP appears in this server's own
 * traffic ("Seen 24h" from the enrichment join). Server-paginated against
 * /crowdsec/decisions, one row per target; origin scope toggles between
 * local and crowd bans.
 */
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

  const { data, isLoading, isError, isPlaceholderData } = useCrowdsecDecisions({
    origins,
    currentPage: page,
    pageSize,
  })
  const [selected, setSelected] = useState<DecisionRef | null>(null)

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = status?.writeEnabled ? 9 : 8

  return (
    <Card className="py-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Active decisions</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {status?.writeEnabled && <BanIpButton />}
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
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <Table>
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
            <TableBody>
              {isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: colCount }).map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : data?.items.map((group) => (
                    <DecisionGroupRows
                      key={`${group.scope}:${group.ip}`}
                      group={group}
                      writeEnabled={status?.writeEnabled === true}
                      dimmed={isPlaceholderData}
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
              {!isLoading && !isError && total === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={colCount}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No active decisions for this origin scope.
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

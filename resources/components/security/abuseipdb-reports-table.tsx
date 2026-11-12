/**
 * Every report GeoMetrikks has sent to AbuseIPDB, newest first. Server-paginated
 * against /abuseipdb/reports/history. A row expands to its comment and attack time.
 */
import { useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { Input } from "@/components/ui/input"
import { PaginationFooter } from "@/components/ui/pagination-footer"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { rowActivation } from "@/components/data/row-activation"
import { IpActionsMenu } from "@/components/ip-actions/ip-actions-menu"
import type { StoredReportDto } from "@/generated/api/types.gen"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { ABUSEIPDB_CATEGORIES, CATEGORY_NAMES, reportCategoryNames, reporterLabel } from "@/lib/abuseipdb"
import { useAbuseIpdbReportHistory } from "@/lib/queries"
import { formatRowTime } from "@/lib/row-time"
import { cn } from "@/lib/utils"
import { ROW_TARGET_VALUE_CLASS, ExpandChevron, RowTarget, TwoLineCell } from "./two-line-cell"

const PAGE_SIZES = [10, 25, 50, 100] as const
const COLUMN_COUNT = 5
const CATEGORY_IDS = [...ABUSEIPDB_CATEGORIES].sort((a, b) => a.name.localeCompare(b.name)).map((category) => category.id)

type ReportStatus = StoredReportDto["status"]
const STATUSES: ReportStatus[] = ["sent", "unconfirmed"]

const categoryLabel = (id: number) => CATEGORY_NAMES.get(id) ?? String(id)
const statusLabel = (status: ReportStatus) => (status === "sent" ? "Sent" : "Unconfirmed")

export function AbuseIpdbReportsTable() {
  const [searchInput, setSearchInput] = useState("")
  const [categories, setCategories] = useState<number[]>([])
  const [statuses, setStatuses] = useState<ReportStatus[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(10)
  const searchRef = useRef<HTMLInputElement>(null)
  const q = useDebouncedValue(searchInput.trim())
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()

  const filterKey = `${q}|${categories.join()}|${statuses.join()}`
  const [filteredBy, setFilteredBy] = useState(filterKey)
  if (filteredBy !== filterKey) {
    setFilteredBy(filterKey)
    setPage(1)
  }

  const { data, isLoading, isError, isPlaceholderData } = useAbuseIpdbReportHistory({
    q: q || undefined,
    categoryIn: categories.length > 0 ? categories : undefined,
    statusIn: statuses.length > 0 ? statuses : undefined,
    currentPage: page,
    pageSize,
  })

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const colCount = narrow ? 1 : COLUMN_COUNT
  const filtered = q !== "" || categories.length > 0 || statuses.length > 0

  return (
    <Card ref={layoutRef} className="py-4 max-md:gap-0 max-md:pt-3">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-2 max-md:pb-2.5">
        <CardTitle className="mr-auto max-md:basis-full text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          AbuseIPDB reports
        </CardTitle>
        <FilterCombobox<number>
          label="Category"
          options={CATEGORY_IDS}
          selected={categories}
          onChange={setCategories}
          labelFor={categoryLabel}
          contentClassName="min-w-60"
        />
        <FilterCombobox<ReportStatus>
          label="Status"
          options={STATUSES}
          selected={statuses}
          onChange={setStatuses}
          labelFor={statusLabel}
          contentClassName="min-w-44"
        />
        <div className="relative max-md:basis-full md:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="IP, comment or sender"
            aria-label="Search AbuseIPDB reports"
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
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <Table className={narrow ? "table-fixed" : undefined}>
            {!narrow && (
              <TableHeader>
                <TableRow>
                  <TableHead>IP</TableHead>
                  <TableHead>Categories</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Reported</TableHead>
                  <TableHead>Sent by</TableHead>
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              {isLoading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: colCount }).map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : data?.items?.map((report) => (
                    <ReportRows key={report.id} report={report} narrow={narrow} dimmed={isPlaceholderData} colCount={colCount} />
                  ))}
              {!isLoading && isError && !data && (
                <TableRow>
                  <TableCell colSpan={colCount} className="h-24 text-center text-destructive">
                    Failed to load reports.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && !isPlaceholderData && total === 0 && (
                <TableRow>
                  <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                    {filtered ? "No reports match these filters." : "GeoMetrikks hasn't sent any reports yet."}
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
    </Card>
  )
}

function UnconfirmedBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      title="AbuseIPDB did not confirm this report. It may have been sent."
      className={cn("text-amber-500", className)}
    >
      Unconfirmed
    </Badge>
  )
}

function ReportRows({
  report,
  narrow,
  dimmed,
  colCount,
}: {
  report: StoredReportDto
  narrow: boolean
  dimmed: boolean
  colCount: number
}) {
  const [open, setOpen] = useState(false)
  const reportedAt = formatRowTime(report.reportedAt, { seconds: false })
  const categories = reportCategoryNames(report.categories).join(", ")
  const score = report.abuseConfidenceScore === null ? null : `${report.abuseConfidenceScore}%`
  const activation = {
    "aria-expanded": open,
    "aria-label": `Report of ${report.ipAddress}, ${report.reportedAt}`,
    ...rowActivation<HTMLTableRowElement>(() => setOpen((current) => !current)),
  }
  const unconfirmed = report.status === "unconfirmed"

  return (
    <>
      <TableRow {...activation} className={cn(activation.className, dimmed && "opacity-60")}>
        {narrow ? (
          <TwoLineCell
            top={
              <RowTarget
                open={open}
                countryCode={null}
                countryName={null}
                value={<span className={ROW_TARGET_VALUE_CLASS}>{report.ipAddress}</span>}
                actions={<IpActionsMenu ip={report.ipAddress} />}
                status={unconfirmed ? <UnconfirmedBadge /> : <span className="tabular-nums">{score}</span>}
              />
            }
            bottom={<span className="truncate text-muted-foreground">{categories}</span>}
            bottomEnd={<span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{reportedAt}</span>}
          />
        ) : (
          <>
            <TableCell className="font-mono">
              <ExpandChevron open={open} />
              {report.ipAddress}
              <IpActionsMenu ip={report.ipAddress} />
              {unconfirmed && <UnconfirmedBadge className="ml-2 align-middle font-sans" />}
            </TableCell>
            <TableCell className="max-w-[320px] truncate" title={categories}>
              {categories}
            </TableCell>
            <TableCell className="text-right tabular-nums">{score ?? "-"}</TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">{reportedAt}</TableCell>
            <TableCell>{reporterLabel(report)}</TableCell>
          </>
        )}
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/40">
          <TableCell colSpan={colCount} className="whitespace-normal py-2.5">
            <dl className="grid gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Comment</dt>
                <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{report.comment}</dd>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <div>
                  <dt className="text-muted-foreground">Attack time</dt>
                  <dd className="tabular-nums">{new Date(report.attackTime).toLocaleString()}</dd>
                </div>
                {narrow && (
                  <div>
                    <dt className="text-muted-foreground">Sent by</dt>
                    <dd>{reporterLabel(report)}</dd>
                  </div>
                )}
              </div>
            </dl>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

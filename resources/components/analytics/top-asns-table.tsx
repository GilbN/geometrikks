import { Badge } from "@/components/ui/badge"
import { AsnCategoryInfo } from "@/components/analytics/asn-category-info"
import { DropBadge } from "@/components/drop/drop-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatNumber } from "@/lib/api"
import { useTopAsns } from "@/lib/queries"
import { useAnalyticsFilters } from "@/lib/analytics-filters-context"
import { asnFilterTarget } from "@/lib/ip-filter-targets"
import { AsnActionsMenu } from "@/components/ip-actions/asn-actions-menu"
import { AsnReportButton, useAbuseReportDialog } from "@/components/abuse-report/abuse-report-dialog"
import { useFitLayout } from "@/components/data/narrow-layout"
import { RankedNarrowCell, RankedNarrowHeader } from "@/components/data/ranked-narrow"
import { TablePaginationFooter, usePagedRows } from "./table-pagination"

export function CategoryBadge({ category }: { category: "drop" | "hosting" | "other" }) {
  if (category === "drop") return <DropBadge variant="short" list="asn-drop" />
  return category === "hosting" ? (
    <Badge variant="secondary" className="gap-1.5">
      <span className="size-1.5 rounded-full bg-primary" />
      Hosting
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Other
    </Badge>
  )
}

export function TopAsnsTable() {
  const { data, isError, error } = useTopAsns({ limit: 25 })
  const { pageItems, ...pagination } = usePagedRows(data?.items)
  const report = useAbuseReportDialog()
  const { filters, setFilters } = useAnalyticsFilters()
  const actions = (asn: number, organization: string | null | undefined) => (
    <span className="inline-flex items-center">
      <AsnReportButton asn={asn} organization={organization} onOpen={report.openFor} />
      <AsnActionsMenu asn={asn} organization={organization} target={asnFilterTarget(asn, filters, setFilters)} />
    </span>
  )
  const [layoutRef, narrow] = useFitLayout<HTMLDivElement>(pageItems.map((row) => row.asn).join())

  return (
    <Card ref={layoutRef}>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Top ASNs</CardTitle>
      </CardHeader>
      <CardContent>
        {isError && !data ? (
          <p className="text-sm text-destructive">
            Failed to load ASN statistics: {error?.message ?? "Unknown error"}
          </p>
        ) : !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Table className={narrow ? "table-fixed" : undefined}>
              {narrow ? (
                <RankedNarrowHeader
                  label={
                    <>
                      Organization
                      <AsnCategoryInfo />
                    </>
                  }
                  valueLabel="Hits"
                />
              ) : (
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>ASN</TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1.5">
                        Category
                        <AsnCategoryInfo />
                      </span>
                    </TableHead>
                    <TableHead className="text-right">Hits</TableHead>
                    <TableHead className="text-right">Bytes</TableHead>
                    <TableHead className="w-16"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                {pageItems.map((row) => narrow ? (
                  <TableRow key={row.asn}>
                    <RankedNarrowCell
                      primary={<span className="line-clamp-2" title={row.organization ?? undefined}>{row.organization ?? "Unknown"}</span>}
                      value={formatNumber(row.hits)}
                      trailing={actions(row.asn, row.organization)}
                      secondary={
                        <>
                          <span className="font-mono">AS{row.asn}</span>
                          <CategoryBadge category={row.category} />
                          <span>{formatBytes(row.totalBytes)}</span>
                        </>
                      }
                    />
                  </TableRow>
                ) : (
                  <TableRow key={row.asn}>
                    <TableCell className="max-w-[420px] truncate" title={row.organization ?? undefined}>
                      {row.organization ?? "Unknown"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">AS{row.asn}</TableCell>
                    <TableCell><CategoryBadge category={row.category} /></TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(row.totalBytes)}</TableCell>
                    <TableCell className="py-0 text-right">{actions(row.asn, row.organization)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TablePaginationFooter {...pagination} onPageChange={pagination.setPage} />
            {report.dialog}
          </>
        )}
      </CardContent>
    </Card>
  )
}

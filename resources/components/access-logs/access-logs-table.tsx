/**
 * Historical access-logs table: server-paginated, newest-first, scoped to the
 * global time range. Pairs with GET /api/v1/access-logs/.
 */
import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useAccessLogs } from "@/lib/queries"
import { formatBytes, formatDuration } from "@/lib/api"

const PAGE_SIZE = 50

function statusVariant(code: number): "destructive" | "outline" | "secondary" {
  if (code >= 500) return "destructive"
  if (code >= 400) return "outline"
  return "secondary"
}

export function AccessLogsTable() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, isPlaceholderData } = useAccessLogs({
    currentPage: page,
    pageSize: PAGE_SIZE,
  })

  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (isError) {
    return (
      <div className="rounded-md border p-6 text-sm text-destructive">
        Failed to load access logs.
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      <div className="overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>IP</TableHead>
              <TableHead className="text-right">Bytes</TableHead>
              <TableHead className="text-right">Req time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(row.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(row.statusCode)} className="tabular-nums">
                        {row.statusCode}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono">{row.method ?? "-"}</TableCell>
                    <TableCell
                      className="max-w-[320px] truncate font-mono"
                      title={row.url ?? undefined}
                    >
                      {row.url ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono">{row.ipAddress}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(row.bytesSent)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(row.requestTime * 1000)}
                    </TableCell>
                  </TableRow>
                ))}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No access logs in this time range.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
        <span>
          {total.toLocaleString()} rows — page {page} of {pageCount}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || isPlaceholderData}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount || isPlaceholderData}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

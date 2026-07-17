import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"

export const TABLE_PAGE_SIZE = 10

/** Client-side pagination over an already-fetched list. */
export function usePagedRows<T>(items: T[] | undefined, pageSize = TABLE_PAGE_SIZE) {
  const [page, setPage] = useState(1)
  const total = items?.length ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pageCount) // clamp when the list shrinks (e.g. after a filter change)
  const start = (current - 1) * pageSize
  const pageItems = (items ?? []).slice(start, start + pageSize)
  return { pageItems, page: current, pageCount, total, setPage, pageSize }
}

export function TablePaginationFooter({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
}: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
}) {
  if (total <= pageSize) return null
  return (
    <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
      <span>
        {total} rows - page {page} of {pageCount}
      </span>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

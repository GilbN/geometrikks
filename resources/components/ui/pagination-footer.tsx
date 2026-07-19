/**
 * Shared table pagination footer: row count, optional rows-per-page select,
 * and Prev/Next. Wraps onto multiple lines on narrow screens instead of
 * overflowing its container.
 */
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

interface PaginationFooterProps {
  page: number
  pageCount: number
  total: number
  onPageChange: (page: number) => void
  /** Disable Prev/Next (e.g. while placeholder data is showing). */
  disabled?: boolean
  /** Provide all three to render the rows-per-page select. */
  pageSize?: number
  pageSizes?: readonly number[]
  onPageSizeChange?: (size: number) => void
  className?: string
}

export function PaginationFooter({
  page,
  pageCount,
  total,
  onPageChange,
  disabled = false,
  pageSize,
  pageSizes,
  onPageSizeChange,
  className,
}: PaginationFooterProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="whitespace-nowrap">
        {total.toLocaleString()} rows - page {page} of {pageCount}
      </span>
      <div className="flex grow flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {pageSize !== undefined && pageSizes && onPageSizeChange && (
          <div className="flex items-center gap-1.5">
            {/* The select's aria-label carries the name when the visible
                label is hidden on narrow screens to fit one control row. */}
            <span className="hidden whitespace-nowrap sm:inline">Rows per page</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
            >
              <SelectTrigger
                size="sm"
                aria-label="Rows per page"
                className="h-8 w-20 text-xs pointer-coarse:h-10"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-10"
            disabled={page <= 1 || disabled}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-10"
            disabled={page >= pageCount || disabled}
            onClick={() => onPageChange(page + 1)}
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

import { useState } from "react"

import { PaginationFooter } from "@/components/ui/pagination-footer"

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
    <PaginationFooter
      page={page}
      pageCount={pageCount}
      total={total}
      onPageChange={onPageChange}
      className="px-0 pt-3 pb-0"
    />
  )
}

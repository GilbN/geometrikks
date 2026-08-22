import { useId } from "react"

import { ErrorBanner } from "@/components/error-banner"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { FRAME_LABEL, FRAME_SURFACE } from "./frame"
import type { DataState } from "./types"

function TableSkeleton() {
  return (
    <div data-slot="data-table-frame-loading" aria-hidden className="min-h-64 space-y-3 p-4">
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="grid grid-cols-[minmax(8rem,2fr)_repeat(2,minmax(5rem,1fr))] gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * One card around a table: title, help text, result count and tools in the
 * header, the table (or its loading/error/empty stand-in) in the body, and
 * pagination in the footer. The header and footer stay put across states.
 */
export function DataTableFrame({
  title,
  description,
  count,
  tools,
  state,
  error = "The data could not be loaded.",
  empty = "No data to display.",
  footer,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"section">, "title" | "aria-labelledby"> & {
  title: string
  description?: string
  count?: number
  tools?: React.ReactNode
  state: DataState
  error?: string
  empty?: React.ReactNode
  footer?: React.ReactNode
}) {
  const titleId = useId()
  return (
    <section
      data-slot="data-table-frame"
      data-state={state}
      aria-labelledby={titleId}
      aria-busy={state === "loading"}
      className={cn(FRAME_SURFACE, className)}
      {...props}
    >
      <header className="flex min-w-0 flex-col gap-3 border-b border-border/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 id={titleId} className={FRAME_LABEL}>
              {title}
            </h2>
            {count !== undefined && (
              <span className="text-xs tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
            )}
          </div>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {tools && <div className="flex min-w-0 flex-wrap items-center gap-2">{tools}</div>}
      </header>

      {state === "loading" && <TableSkeleton />}
      {state === "error" && (
        <div data-slot="data-table-frame-error" className="p-4">
          <ErrorBanner title={error} />
        </div>
      )}
      {state === "empty" && (
        <div
          data-slot="data-table-frame-empty"
          className="flex min-h-40 items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground"
        >
          {empty}
        </div>
      )}
      {state === "ready" && <div className="min-w-0 overflow-x-auto">{children}</div>}

      {footer && <footer className="border-t border-border/50 px-4 py-3">{footer}</footer>}
    </section>
  )
}

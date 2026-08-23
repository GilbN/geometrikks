/**
 * Debug Logs route: raw/malformed log lines captured by the parser, with
 * stat cards and a filterable, paginated table. Rows open a detail dialog
 * showing the full raw line and any linked access-log context.
 */
import { createFileRoute } from "@tanstack/react-router"
import { DebugLogsStats } from "@/components/debug-logs/debug-logs-stats"
import { DebugLogsTable } from "@/components/debug-logs/debug-logs-table"
import { PageHeader } from "@/components/page-header"

export const Route = createFileRoute("/debug-logs")({
  component: DebugLogsPage,
})

function DebugLogsPage() {
  return (
    <div className="p-4 space-y-4">
      <PageHeader
        title="Debug Logs"
        subtitle="Inspect captured source lines, parse failures, and their linked request context."
      />
      <DebugLogsStats />
      <DebugLogsTable />
    </div>
  )
}

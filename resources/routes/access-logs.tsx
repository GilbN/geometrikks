import { createFileRoute } from "@tanstack/react-router"
import { AccessLogsTable } from "@/components/access-logs/access-logs-table"

export const Route = createFileRoute("/access-logs")({
  component: AccessLogsPage,
})

function AccessLogsPage() {
  return (
    <div className="p-4">
      <AccessLogsTable />
    </div>
  )
}

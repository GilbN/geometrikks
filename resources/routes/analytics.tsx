import { createFileRoute } from "@tanstack/react-router"
import { RequestsChart } from "@/components/analytics/requests-chart"
import { StatusChart } from "@/components/analytics/status-chart"
import { BytesChart } from "@/components/analytics/bytes-chart"
import { LatencyChart } from "@/components/analytics/latency-chart"
import { TopUrlsTable } from "@/components/analytics/top-urls-table"
import { TopUserAgentsTable } from "@/components/analytics/top-user-agents-table"

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
})

function AnalyticsPage() {
  return (
    <div className="p-4 space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <RequestsChart />
        <StatusChart />
        <BytesChart />
        <LatencyChart />
      </div>
      <TopUrlsTable />
      <TopUserAgentsTable />
    </div>
  )
}

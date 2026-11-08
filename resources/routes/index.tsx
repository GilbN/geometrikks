import { createFileRoute } from "@tanstack/react-router"
import { Summary } from "@/components/dashboard/summary"

export const Route = createFileRoute("/")({
  staticData: { timeRange: true, cardCharts: "overview" },
  component: SummaryPage,
})

function SummaryPage() {
  return  (
  <>
  <Summary />
  </>
  )
}

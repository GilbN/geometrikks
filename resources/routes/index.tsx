import { createFileRoute } from "@tanstack/react-router"
import { Summary } from "@/components/dashboard/summary"
import { LiveSummary } from "@/components/dashboard/live-summary"

function SummaryPage() {
  return  (
  <>
  <LiveSummary />
  </>
  )
}

export const Route = createFileRoute("/")({
  component: SummaryPage,
})

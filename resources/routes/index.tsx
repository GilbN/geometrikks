import { createFileRoute } from "@tanstack/react-router"
import { Summary } from "@/components/dashboard/summary"

function SummaryPage() {
  return  (
  <>
  <Summary />
  </>
  )
}

export const Route = createFileRoute("/")({
  component: SummaryPage,
})

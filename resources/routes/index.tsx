import { createFileRoute } from "@tanstack/react-router"
import { Summary } from "@/components/dashboard/summary"

export const Route = createFileRoute("/")({
  component: SummaryPage,
})

function SummaryPage() {
  return  (
  <>
  <Summary />
  </>
  )
}

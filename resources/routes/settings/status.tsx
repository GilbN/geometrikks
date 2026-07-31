import { createFileRoute } from "@tanstack/react-router"
import { StatusOverview } from "@/components/settings/status-overview"

export const Route = createFileRoute("/settings/status")({
  component: StatusOverview,
})

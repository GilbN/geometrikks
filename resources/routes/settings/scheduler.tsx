import { createFileRoute } from "@tanstack/react-router"
import { SchedulerOverview } from "@/components/settings/scheduler-overview"

export const Route = createFileRoute("/settings/scheduler")({
  component: SchedulerOverview,
})

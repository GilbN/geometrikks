import { createFileRoute } from "@tanstack/react-router"
import { LogsOverview } from "@/components/settings/logs-overview"

export const Route = createFileRoute("/settings/logs")({
  component: LogsOverview,
})

import { createFileRoute } from "@tanstack/react-router"
import { EnvironmentOverview } from "@/components/settings/environment-overview"

export const Route = createFileRoute("/settings/environment")({
  component: EnvironmentOverview,
})

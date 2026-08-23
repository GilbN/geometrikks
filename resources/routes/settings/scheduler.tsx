import { createFileRoute } from "@tanstack/react-router"
import { SchedulerOverview } from "@/components/settings/scheduler-overview"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/scheduler")({
  component: () => (
    <SettingsPage
      title="Scheduler"
      subtitle="Inspect background tasks, recent runs, and the next scheduled execution."
    >
      <SchedulerOverview />
    </SettingsPage>
  ),
})

import { createFileRoute } from "@tanstack/react-router"
import { LogsOverview } from "@/components/settings/logs-overview"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/logs")({
  component: () => (
    <SettingsPage
      title="Logs"
      subtitle="Tail application and login events, inspect full records, and download raw log files."
    >
      <LogsOverview />
    </SettingsPage>
  ),
})

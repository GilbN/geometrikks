import { createFileRoute } from "@tanstack/react-router"
import { StatusOverview } from "@/components/settings/status-overview"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/status")({
  component: () => (
    <SettingsPage
      title="System status"
      subtitle="Check ingestion, storage, enrichment, integrations, and live services."
    >
      <StatusOverview />
    </SettingsPage>
  ),
})

import { createFileRoute } from "@tanstack/react-router"
import { EnvironmentOverview } from "@/components/settings/environment-overview"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/environment")({
  component: () => (
    <SettingsPage
      title="Environment"
      subtitle="Inspect resolved runtime settings and their environment overrides. Secret values remain hidden."
    >
      <EnvironmentOverview />
    </SettingsPage>
  ),
})

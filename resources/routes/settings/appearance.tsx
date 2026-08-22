import { createFileRoute } from "@tanstack/react-router"
import { AppearancePage } from "@/components/settings/appearance-page"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/appearance")({
  component: () => (
    <SettingsPage
      title="Appearance"
      subtitle="Choose the color mode and accent used in this browser."
    >
      <AppearancePage />
    </SettingsPage>
  ),
})

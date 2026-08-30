import { createFileRoute } from "@tanstack/react-router"
import { ChangelogPage } from "@/components/settings/changelog-page"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/changelog")({
  component: () => (
    <SettingsPage
      title="Changelog"
      subtitle="What changed in each release, and which one this install is running."
    >
      <ChangelogPage />
    </SettingsPage>
  ),
})

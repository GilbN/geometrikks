import { createFileRoute } from "@tanstack/react-router"
import { AboutPage } from "@/components/settings/about-page"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/about")({
  component: () => (
    <SettingsPage
      title="About"
      subtitle="Review this installation, runtime, and data services."
    >
      <AboutPage />
    </SettingsPage>
  ),
})

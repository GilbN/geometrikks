import { createFileRoute, redirect } from "@tanstack/react-router"
import { SettingsHome } from "@/components/settings/settings-home"
import { isMobileViewport } from "@/hooks/use-mobile"

export const Route = createFileRoute("/settings/")({
  // From md up the side nav lists the sections, so /settings opens Status.
  // On a phone it lists them itself.
  beforeLoad: () => {
    if (!isMobileViewport()) throw redirect({ to: "/settings/status" })
  },
  component: SettingsHome,
})

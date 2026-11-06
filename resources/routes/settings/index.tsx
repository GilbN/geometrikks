import { createFileRoute, redirect } from "@tanstack/react-router"
import { SettingsHome } from "@/components/settings/settings-home"
import { isMobileViewport } from "@/hooks/use-mobile"
import { isPhoneSideViewport } from "@/hooks/use-phone-map"
import { isPortraitList } from "@/lib/phone-layout"

export const Route = createFileRoute("/settings/")({
  // The side nav or the chip row lists the sections, so /settings opens
  // Status. On a portrait phone it lists them itself.
  beforeLoad: () => {
    if (!isPortraitList(isMobileViewport(), isPhoneSideViewport())) throw redirect({ to: "/settings/status" })
  },
  component: SettingsHome,
})

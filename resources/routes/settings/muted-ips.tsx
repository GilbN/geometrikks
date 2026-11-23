import { createFileRoute } from "@tanstack/react-router"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { MutedIpsOverview } from "@/components/settings/muted-ips-overview"
import { SettingsPage } from "@/components/settings/settings-page"

export const Route = createFileRoute("/settings/muted-ips")({
  component: MutedIpsRoute,
})

function MutedIpsRoute() {
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  return (
    <SettingsPage
      title="Muted IPs"
      subtitle="Hidden from Access Logs, Geo Logs and Analytics while their Muted IPs switch is on. Rows are still stored."
      subtitleOnPhone
    >
      <div ref={layoutRef}>
        <MutedIpsOverview narrow={narrow} />
      </div>
    </SettingsPage>
  )
}

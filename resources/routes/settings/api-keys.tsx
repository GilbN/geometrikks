import { useRef } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { ApiKeysOverview, CreateApiKey } from "@/components/settings/api-keys-overview"
import { SettingsPage } from "@/components/settings/settings-page"
import { useApiKeys } from "@/lib/queries"

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysRoute,
})

function ApiKeysRoute() {
  const { data } = useApiKeys()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  return (
    <SettingsPage
      title="API keys"
      subtitle="For scripts, monitors and dashboards. Browser logins don't use them."
      subtitleOnPhone
      actions={data?.available ? <CreateApiKey narrow={narrow} triggerRef={createButtonRef} /> : undefined}
    >
      <div ref={layoutRef}>
        <ApiKeysOverview narrow={narrow} focusOutsideList={() => createButtonRef.current?.focus()} />
      </div>
    </SettingsPage>
  )
}

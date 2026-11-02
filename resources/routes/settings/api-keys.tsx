import { useRef } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { ApiKeysOverview, CreateApiKeyDialog } from "@/components/settings/api-keys-overview"
import { SettingsPage } from "@/components/settings/settings-page"
import { useApiKeys } from "@/lib/queries"

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysRoute,
})

function ApiKeysRoute() {
  const { data } = useApiKeys()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  return (
    <SettingsPage
      title="API keys"
      subtitle="For scripts, monitors and dashboards. Browser logins don't use them."
      actions={data?.available ? <CreateApiKeyDialog triggerRef={createButtonRef} /> : undefined}
    >
      <ApiKeysOverview focusOutsideList={() => createButtonRef.current?.focus()} />
    </SettingsPage>
  )
}

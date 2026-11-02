import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { ApiKeysOverview, CreateApiKeyButton, CreateApiKeyDialog } from "@/components/settings/api-keys-overview"
import { SettingsPage } from "@/components/settings/settings-page"
import { useApiKeys } from "@/lib/queries"

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysRoute,
})

function ApiKeysRoute() {
  const { data } = useApiKeys()
  const [createOpen, setCreateOpen] = useState(false)
  const openCreate = () => setCreateOpen(true)
  return (
    <SettingsPage
      title="API keys"
      subtitle="For scripts, monitors and dashboards. Browser logins don't use them."
      actions={data?.available ? <CreateApiKeyButton onClick={openCreate} /> : undefined}
    >
      <ApiKeysOverview onCreate={openCreate} />
      <CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </SettingsPage>
  )
}

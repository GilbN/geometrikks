import { createFileRoute } from "@tanstack/react-router"
import { AgentsOverview } from "@/components/settings/agents-overview"
import { instanceSearchValue } from "@/components/settings/agents-logic"
import { SettingsPage } from "@/components/settings/settings-page"

type AgentsSearch = { instance?: string }

export const Route = createFileRoute("/settings/agents")({
  validateSearch: (search: Record<string, unknown>): AgentsSearch => {
    const instance = instanceSearchValue(search.instance)
    return instance === undefined ? {} : { instance }
  },
  component: AgentsRoute,
})

function AgentsRoute() {
  const { instance } = Route.useSearch()
  return (
    <SettingsPage
      title="Agents"
      subtitle="Check which instances write to this database and what each one reports."
    >
      <AgentsOverview focusInstance={instance} />
    </SettingsPage>
  )
}

import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router"

import { PageHeader } from "@/components/page-header"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
})

const tabs = [
  { to: "/settings/status", label: "Status" },
  { to: "/settings/environment", label: "Environment" },
  { to: "/settings/scheduler", label: "Scheduler" },
  { to: "/settings/logs", label: "Logs" },
  { to: "/settings/about", label: "About" },
] as const

function SettingsLayout() {
  const navigate = Route.useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const activeTab = tabs.find((tab) => pathname.startsWith(tab.to)) ?? tabs[0]

  const handleTabChange = (value: string) => {
    const tab = tabs.find((candidate) => candidate.to === value)
    if (tab) {
      void navigate({ to: tab.to })
    }
  }

  return (
    <div className="p-4 space-y-4">
      <PageHeader
        title="Settings"
        subtitle="Runtime status, environment, and instance information."
      />
      <Select value={activeTab.to} onValueChange={handleTabChange}>
        <SelectTrigger aria-label="Settings section" className="h-10 w-full sm:hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {tabs.map((tab) => (
            <SelectItem key={tab.to} value={tab.to}>
              {tab.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <nav
        aria-label="Settings"
        className="hidden h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground sm:inline-flex"
      >
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all hover:text-foreground"
            activeProps={{ className: "bg-background text-foreground shadow-sm" }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}

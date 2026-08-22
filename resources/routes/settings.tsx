import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router"

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
  { to: "/settings/appearance", label: "Appearance" },
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
    <div className="min-w-0 p-4 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-8 md:p-6">
      <Select value={activeTab.to} onValueChange={handleTabChange}>
        <SelectTrigger aria-label="Settings section" className="mb-4 h-10 w-full md:hidden">
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
        className="hidden self-start md:sticky md:top-4 md:block"
      >
        <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Settings
        </p>
        <ul className="space-y-0.5 border-l border-border/50">
          {tabs.map((tab) => (
            <li key={tab.to}>
              <Link
                to={tab.to}
                className="relative -ml-px flex items-center border-l-2 border-transparent py-1.5 pl-3 pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                activeProps={{ className: "border-primary font-medium text-foreground" }}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  )
}

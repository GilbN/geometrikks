import { createFileRoute, Link, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
})

const tabs = [
  { to: "/settings/environment", label: "Environment" },
  { to: "/settings/scheduler", label: "Scheduler" },
  { to: "/settings/about", label: "About" },
] as const

function SettingsLayout() {
  return (
    <div className="p-4 space-y-4">
      <div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
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
      </div>
      <Outlet />
    </div>
  )
}

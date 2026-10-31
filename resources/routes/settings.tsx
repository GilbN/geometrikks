import { createFileRoute, Link, Outlet } from "@tanstack/react-router"
import { MapBackdrop } from "@/components/brand/backdrops"
import { useChangelogUnseen, useUnseenRelease } from "@/lib/queries"

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
})

const tabs = [
  { to: "/settings/status", label: "Status" },
  { to: "/settings/agents", label: "Agents" },
  { to: "/settings/environment", label: "Environment" },
  { to: "/settings/scheduler", label: "Scheduler" },
  { to: "/settings/logs", label: "Logs" },
  { to: "/settings/appearance", label: "Appearance" },
  { to: "/settings/changelog", label: "Changelog" },
  { to: "/settings/about", label: "About" },
] as const

function UnseenDot({ label }: { label: string }) {
  return (
    <span
      className="ml-2 inline-flex h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]"
      aria-label={label}
      role="img"
    />
  )
}

function SettingsLayout() {
  const changelogUnseen = useChangelogUnseen()
  const unseenRelease = useUnseenRelease()
  const dotLabel = (tab: (typeof tabs)[number]): string | null => {
    if (tab.to === "/settings/changelog" && changelogUnseen) return "New changes to read"
    if (tab.to === "/settings/about" && unseenRelease) return `${unseenRelease.displayVersion} is available`
    return null
  }

  return (
    <div className="relative min-h-full min-w-0">
      <MapBackdrop mode="viewport" />
      {/* Glass cards, scoped to Settings: the backdrop shows through them
          softly instead of only between them. */}
      <div className="relative min-w-0 p-4 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-8 md:p-6 [&_[data-slot=card]]:bg-glass-card [&_[data-slot=card]]:backdrop-blur-[2px]">
      {/* Phones reach the sections from the /settings list and come back
          with the top bar's Settings link. */}
      <nav
        aria-label="Settings"
        className="relative hidden self-start rounded-xl bg-glass-card-strong p-3 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px] md:sticky md:top-4 md:block"
      >
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Settings
        </p>
        <ul className="space-y-0.5 border-l border-border/50">
          {tabs.map((tab) => {
            const unseenLabel = dotLabel(tab)
            return (
              <li key={tab.to}>
                <Link
                  to={tab.to}
                  className="relative -ml-px flex items-center border-l-2 py-1.5 pl-3 pr-2 text-sm transition-colors"
                  activeProps={{ className: "border-primary font-medium text-foreground" }}
                  inactiveProps={{ className: "border-transparent text-muted-foreground hover:text-foreground" }}
                >
                  {tab.label}
                  {unseenLabel && <UnseenDot label={unseenLabel} />}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="relative min-w-0">
        <Outlet />
      </div>
      </div>
    </div>
  )
}

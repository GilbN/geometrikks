import { useLayoutEffect, useRef } from "react"
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router"
import { MapBackdrop } from "@/components/brand/backdrops"
import { useChipReveal, useChipRowFades } from "@/hooks/use-chip-reveal"
import { useChangelogUnseen, useUnseenRelease } from "@/lib/queries"

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
})

const tabs = [
  { to: "/settings/status", label: "Status" },
  { to: "/settings/agents", label: "Agents" },
  { to: "/settings/environment", label: "Environment" },
  { to: "/settings/api-keys", label: "API keys" },
  { to: "/settings/scheduler", label: "Scheduler" },
  { to: "/settings/logs", label: "Logs" },
  { to: "/settings/appearance", label: "Appearance" },
  { to: "/settings/changelog", label: "Changelog" },
  { to: "/settings/about", label: "About" },
] as const

function UnseenDot({ label }: { label: string }) {
  return (
    <span
      className="ml-2 inline-flex h-1.5 w-1.5 phone-side:ml-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]"
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
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const layoutRef = useRef<HTMLDivElement>(null)
  const chipRowRef = useRef<HTMLUListElement>(null)
  useChipReveal(chipRowRef, pathname)
  const fades = useChipRowFades(chipRowRef)

  useLayoutEffect(() => {
    const main = layoutRef.current?.closest("main")
    if (main) main.scrollTop = 0
  }, [pathname])

  return (
    <div ref={layoutRef} className="relative min-h-full min-w-0">
      <MapBackdrop mode="viewport" />
      {/* Glass cards, scoped to Settings: the backdrop shows through them
          softly instead of only between them. */}
      <div className="relative min-w-0 p-4 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-8 md:p-6 phone-side:block phone-side:p-4 phone-side:pt-0 [&_[data-slot=card]]:bg-glass-card [&_[data-slot=card]]:backdrop-blur-[2px]">
      {/* Portrait phones reach the sections from the /settings list and come
          back with the top bar's Settings link; a phone held sideways shows
          this nav as a row of chips. phone-side: classes win over md: ones
          only by coming later in the stylesheet (md:not-phone-side: compiles
          to a query browsers drop), so every md: rule here needs its
          phone-side: undo. */}
      <nav
        aria-label="Settings"
        className="relative hidden self-start rounded-xl bg-glass-card-strong p-3 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px] md:sticky md:top-4 md:block phone-side:relative phone-side:top-0 phone-side:block phone-side:p-0 phone-side:bg-transparent phone-side:ring-0 phone-side:shadow-none phone-side:backdrop-blur-none"
      >
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground phone-side:hidden">
          Settings
        </p>
        <ul
          ref={chipRowRef}
          className="space-y-0.5 border-l border-border/50 phone-side:flex phone-side:gap-1.5 phone-side:space-y-0 phone-side:overflow-x-auto phone-side:border-l-0 phone-side:py-1.5 phone-side:[scroll-padding-inline:48px] phone-side:[scrollbar-width:none]"
        >
          {tabs.map((tab) => {
            const unseenLabel = dotLabel(tab)
            return (
              <li key={tab.to} className="phone-side:shrink-0">
                <Link
                  to={tab.to}
                  className="group relative -ml-px flex items-center border-l-2 py-1.5 pl-3 pr-2 text-sm transition-colors phone-side:ml-0 phone-side:h-11 phone-side:border-l-0 phone-side:p-0 phone-side:text-[13px] phone-side:outline-none"
                  activeProps={{ className: "border-primary font-medium text-foreground phone-side:font-normal phone-side:text-primary" }}
                  inactiveProps={{ className: "border-transparent text-muted-foreground hover:text-foreground" }}
                >
                  <span className="contents phone-side:flex phone-side:h-8 phone-side:items-center phone-side:rounded-full phone-side:border phone-side:border-border phone-side:bg-card phone-side:px-3 phone-side:group-aria-[current=page]:border-transparent phone-side:group-aria-[current=page]:bg-foreground/9 phone-side:group-focus-visible:ring-2 phone-side:group-focus-visible:ring-ring">
                    {tab.label}
                    {unseenLabel && <UnseenDot label={unseenLabel} />}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
        {fades.start && (
          <span
            aria-hidden
            data-fade="start"
            className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-linear-to-r from-background to-transparent"
          />
        )}
        {fades.end && (
          <span
            aria-hidden
            data-fade="end"
            className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-linear-to-l from-background to-transparent"
          />
        )}
      </nav>
      <div className="relative min-w-0">
        <Outlet />
      </div>
      </div>
    </div>
  )
}

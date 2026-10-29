/**
 * /settings on a phone: the eight sections in three groups, each with one
 * live line, instead of a dropdown above whichever page opened first. From
 * md up /settings still redirects to Status and the side nav lists sections.
 */
import { useEffect, useId } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  Activity,
  CalendarClock,
  ChevronRight,
  FileClock,
  Info,
  Network,
  Palette,
  ScrollText,
  SlidersHorizontal,
} from "lucide-react"
import { GlowDot } from "@/components/reload-notice"
import { useTheme } from "@/components/theme-provider"
import { StatusLed, type LedTone } from "@/components/settings/status-led"
import { agentAdvisoryCards, agentsNeedingAttention, agentSummary } from "@/components/settings/agents-logic"
import { isOverridden } from "@/components/settings/environment-overview"
import {
  advisoryCards,
  overallState,
  schedulerSummary,
  statusProblems,
  verdictTitle,
} from "@/components/settings/status-logic"
import {
  useAbout,
  useChangelogUnseen,
  useHealth,
  useInstances,
  useSchedulerJobs,
  useSystemSettings,
  useUnseenRelease,
} from "@/lib/queries"
import { THEME_CATALOG } from "@/lib/theme"
import { useIsMobile } from "@/hooks/use-mobile"
import { displayVersion, publicVersion } from "@/lib/version"

interface SectionLink {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  line: string
  tone?: LedTone
  /** Something new behind this row: a dot, plus screen reader text when the line doesn't already say it. */
  unseen?: true | string
}

export function SettingsHome() {
  const { data: health, isError: healthError } = useHealth()
  const { data: instances, isError: instancesError } = useInstances()
  const { data: schedulerData, isError: jobsError } = useSchedulerJobs()
  const { data: settings } = useSystemSettings()
  const { data: about } = useAbout()
  const changelogUnseen = useChangelogUnseen()
  const unseenRelease = useUnseenRelease()
  const { resolvedTheme, colorTheme } = useTheme()
  const idPrefix = useId()
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  // From md up the side nav lists the sections; a window widened past md
  // goes where /settings goes there.
  useEffect(() => {
    if (!isMobile) void navigate({ to: "/settings/status", replace: true })
  }, [isMobile, navigate])

  const overall = overallState(health, healthError, instancesError ? 0 : agentsNeedingAttention(instances).length)
  const problems = statusProblems(advisoryCards(health), instancesError ? [] : agentAdvisoryCards(instances))
  const agents = instancesError ? null : agentSummary(instances)
  const scheduler = schedulerSummary(schedulerData?.jobs, jobsError, Date.now())
  const fields = settings?.sections.flatMap((section) => section.fields)

  const groups: { title: string; links: SectionLink[] }[] = [
    {
      title: "Health",
      links: [
        {
          to: "/settings/status",
          label: "Status",
          icon: Activity,
          line: verdictTitle(overall, problems.length),
          tone: overall.tone,
        },
        {
          to: "/settings/agents",
          label: "Agents",
          icon: Network,
          line: instancesError
            ? "Agent list unavailable"
            : !instances
              ? "Loading"
              : (agents?.line ?? "No agents report to this head"),
          tone: agents?.tone,
        },
        {
          to: "/settings/scheduler",
          label: "Scheduler",
          icon: CalendarClock,
          line: [scheduler.label, scheduler.detail?.toLowerCase()].filter(Boolean).join(", "),
          tone: scheduler.tone,
        },
        { to: "/settings/logs", label: "Logs", icon: ScrollText, line: "System log and login log" },
      ],
    },
    {
      title: "Configuration",
      links: [
        {
          to: "/settings/environment",
          label: "Environment",
          icon: SlidersHorizontal,
          // Counted as the Environment page counts them.
          line: fields
            ? `${fields.filter(isOverridden).length} of ${fields.filter((field) => field.envVar).length} settings overridden`
            : "Settings from the environment",
        },
        {
          to: "/settings/appearance",
          label: "Appearance",
          icon: Palette,
          line: `${THEME_CATALOG[colorTheme].label}, ${resolvedTheme}`,
        },
      ],
    },
    {
      title: "This install",
      links: [
        {
          to: "/settings/changelog",
          label: "Changelog",
          icon: FileClock,
          line: changelogUnseen ? "New changes to read" : "What changed in each release",
          unseen: changelogUnseen || undefined,
        },
        {
          to: "/settings/about",
          label: "About",
          icon: Info,
          line: about ? displayVersion(publicVersion(about.app.version)) : "Version and links",
          unseen: unseenRelease ? `${unseenRelease.displayVersion} is available` : undefined,
        },
      ],
    },
  ]

  return (
    <div className="space-y-5">
      <h1 className="sr-only">Settings</h1>
      {groups.map((group, index) => (
        <section key={group.title} aria-labelledby={`${idPrefix}-${index}`} className="space-y-2">
          <h2 id={`${idPrefix}-${index}`} className="px-1 text-xs font-medium text-muted-foreground">
            {group.title}
          </h2>
          <ul className="overflow-hidden rounded-xl bg-glass-card ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px]">
            {group.links.map((link) => (
              <li key={link.to} className="border-b border-border/50 last:border-b-0">
                <Link to={link.to} className="flex min-h-15 items-center gap-3 px-3 py-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <link.icon className="size-4 text-primary" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {link.label}
                      {link.unseen && (
                        <>
                          <GlowDot />
                          {typeof link.unseen === "string" && <span className="sr-only">, {link.unseen}</span>}
                        </>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {link.tone && link.tone !== "emerald" && link.tone !== "muted" && <StatusLed tone={link.tone} />}
                      <span className="truncate">{link.line}</span>
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

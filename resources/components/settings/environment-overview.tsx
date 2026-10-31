import { useState } from "react"
import { Search, Settings2, SlidersHorizontal } from "lucide-react"
import { useSystemSettings } from "@/lib/queries"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import type { SettingFieldView, SettingsSectionView } from "@/generated/api/types.gen"
import {
  envSettingCount,
  fieldMatches,
  formatValue,
  isOverridden,
  sectionIcons,
  ValueBlock,
} from "@/components/settings/environment-fields"
import { EnvironmentPhone } from "@/components/settings/environment-phone"
import { useIsMobile } from "@/hooks/use-mobile"

function FieldRow({ field }: { field: SettingFieldView }) {
  const overridden = isOverridden(field)
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:flex-1">
        <div className="text-sm font-medium">{field.key}</div>
        {field.description && (
          <div className="max-w-md text-xs text-muted-foreground">{field.description}</div>
        )}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1 sm:max-w-1/2 sm:items-end sm:text-right">
        <ValueBlock field={field} />
        <div className="flex items-center gap-2">
          {overridden && !field.isSecret && (
            <span className="text-[11px] text-muted-foreground">
              default: <code className="font-mono">{formatValue(field.default)}</code>
            </span>
          )}
          {field.envVar && <MonoChip>{field.envVar}</MonoChip>}
        </div>
      </div>
    </div>
  )
}

function SectionCard({
  section,
  overriddenCount,
}: {
  section: SettingsSectionView
  overriddenCount: number
}) {
  const Icon = sectionIcons[section.name] ?? Settings2
  return (
    <Card id={`settings-section-${section.name}`} className="scroll-mt-4">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Icon className="h-4 w-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{section.title}</CardTitle>
              {section.description && (
                <CardDescription>{section.description}</CardDescription>
              )}
            </div>
          </div>
          {overriddenCount > 0 && (
            <Badge variant="outline" className="shrink-0 gap-1.5 text-muted-foreground">
              <StatusLed tone="accent" />
              {overriddenCount} overridden
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border/40">
          {section.fields.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function EnvironmentOverview() {
  const { data, isLoading } = useSystemSettings()
  const [query, setQuery] = useState("")
  const [overriddenOnly, setOverriddenOnly] = useState(false)
  const isMobile = useIsMobile()

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (isMobile) return <EnvironmentPhone sections={data.sections} />

  const q = query.trim().toLowerCase()
  const totalOverridden = data.sections.reduce(
    (n, s) => n + s.fields.filter(isOverridden).length,
    0,
  )
  const sections = data.sections
    .map((section) => ({
      ...section,
      overriddenCount: section.fields.filter(isOverridden).length,
      fields: section.fields.filter(
        (f) => (!overriddenOnly || isOverridden(f)) && fieldMatches(f, section, q),
      ),
    }))
    .filter((section) => section.fields.length > 0)

  const jumpTo = (name: string) => {
    document
      .getElementById(`settings-section-${name}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="space-y-4">
      {/* Same glass as the title band above: the toolbar and section
          chips sit on it rather than on the relief. */}
      <div className="space-y-3 rounded-xl bg-glass-card px-4 py-3 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter settings..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full sm:w-64 pl-8"
            />
          </div>
          <Button
            size="sm"
            variant={overriddenOnly ? "secondary" : "outline"}
            onClick={() => setOverriddenOnly((v) => !v)}
            aria-pressed={overriddenOnly}
          >
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
            Overridden only
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusLed tone="accent" />
            {totalOverridden} of {envSettingCount(data.sections)} settings
            overridden by env
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {sections.map((section) => {
            const Icon = sectionIcons[section.name] ?? Settings2
            return (
              <Button
                key={section.name}
                variant="ghost"
                size="xs"
                onClick={() => jumpTo(section.name)}
                className="h-auto gap-1.5 border-border/60 py-1 font-normal text-muted-foreground hover:border-primary/40 hover:bg-transparent dark:hover:bg-transparent"
              >
                <Icon className="text-primary" />
                {section.title}
              </Button>
            )
          })}
        </div>
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {overriddenOnly && !q
            ? "No settings are overridden by env."
            : `No settings match "${query}".`}
        </p>
      ) : (
        sections.map((section) => (
          <SectionCard
            key={section.name}
            section={section}
            overriddenCount={section.overriddenCount}
          />
        ))
      )}
    </div>
  )
}

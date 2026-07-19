import { useState } from "react"
import {
  AppWindow,
  BarChart3,
  Clock,
  Database,
  FileText,
  Globe2,
  Lock,
  Map as MapIcon,
  Network,
  Search,
  Settings2,
  SlidersHorizontal,
  Zap,
} from "lucide-react"
import { useSystemSettings } from "@/lib/queries"
import { cn } from "@/lib/utils"
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

const sectionIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  app: AppWindow,
  api: Network,
  database: Database,
  geoip: Globe2,
  logparser: FileText,
  analytics: BarChart3,
  scheduler: Clock,
  map: MapIcon,
  vite: Zap,
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "not set"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function isOverridden(field: SettingFieldView): boolean {
  // default null means dynamic default (default_factory); never emphasize
  if (field.default === null || field.default === undefined) return false
  return JSON.stringify(field.value) !== JSON.stringify(field.default)
}

function ValueBlock({ field }: { field: SettingFieldView }) {
  if (field.is_secret) {
    const isSet = field.value !== null && field.value !== undefined
    return (
      <span className="inline-flex items-center gap-1.5">
        <Lock className="h-3 w-3 text-muted-foreground" />
        {isSet ? (
          <Badge
            variant="outline"
            className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          >
            set (hidden)
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            not set
          </Badge>
        )}
      </span>
    )
  }
  const overridden = isOverridden(field)
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {overridden && <StatusLed tone="cyan" className="self-center" />}
      <code
        className={cn(
          "font-mono text-xs break-all",
          overridden ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {formatValue(field.value)}
      </code>
    </span>
  )
}

function FieldRow({ field }: { field: SettingFieldView }) {
  const overridden = isOverridden(field)
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{field.key}</div>
        {field.description && (
          <div className="max-w-md text-xs text-muted-foreground">{field.description}</div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end sm:text-right">
        <ValueBlock field={field} />
        <div className="flex items-center gap-2">
          {overridden && !field.is_secret && (
            <span className="text-[11px] text-muted-foreground">
              default: <code className="font-mono">{formatValue(field.default)}</code>
            </span>
          )}
          <MonoChip>{field.env_var}</MonoChip>
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
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
              <Icon className="h-4 w-4 text-geo-cyan" />
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
              <StatusLed tone="cyan" />
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

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

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
        (f) =>
          (!overriddenOnly || isOverridden(f)) &&
          (!q ||
            f.key.toLowerCase().includes(q) ||
            f.env_var.toLowerCase().includes(q) ||
            section.title.toLowerCase().includes(q) ||
            (f.description ?? "").toLowerCase().includes(q)),
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
          <StatusLed tone="cyan" />
          {totalOverridden} of {data.sections.reduce((n, s) => n + s.fields.length, 0)} settings
          overridden by env
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {sections.map((section) => {
          const Icon = sectionIcons[section.name] ?? Settings2
          return (
            <button
              key={section.name}
              type="button"
              onClick={() => jumpTo(section.name)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-geo-cyan/40 hover:text-foreground"
            >
              <Icon className="h-3 w-3 text-geo-cyan" />
              {section.title}
            </button>
          )
        })}
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

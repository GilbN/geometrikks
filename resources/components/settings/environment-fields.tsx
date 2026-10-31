/** Shared by the Environment page's desktop cards and its phone accordion. */
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
  Zap,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { StatusLed } from "@/components/settings/status-led"
import type { SettingFieldView, SettingsSectionView } from "@/generated/api/types.gen"

export const sectionIcons: Record<string, React.ComponentType<{ className?: string }>> = {
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

export const computedLabel: Record<string, string> = {
  external_ip: "auto-detected",
  runtime: "runtime",
}

// JSON.stringify with a space after each comma and colon, so a long list or
// map wraps between items instead of inside an address.
function formatJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatJson).join(", ")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, entryValue]) => `${JSON.stringify(key)}: ${formatJson(entryValue)}`,
    )
    return `{${entries.join(", ")}}`
  }
  return JSON.stringify(value)
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "not set"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "object") return formatJson(value)
  return String(value)
}

export function isOverridden(field: SettingFieldView): boolean {
  // default null means dynamic default (default_factory); never emphasize
  if (field.default === null || field.default === undefined) return false
  return JSON.stringify(field.value) !== JSON.stringify(field.default)
}

export function ValueBlock({ field }: { field: SettingFieldView }) {
  if (field.isSecret) {
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
  const hasValue = field.value !== null && field.value !== undefined
  const hasComputed = field.computedValue !== null && field.computedValue !== undefined
  if (!hasValue && hasComputed) {
    const label = computedLabel[field.computedSource ?? ""] ?? "computed"
    return (
      <span className="inline-flex items-baseline gap-1.5">
        <code className="font-mono text-xs wrap-anywhere font-medium text-foreground">
          {formatValue(field.computedValue)}
        </code>
        <Badge
          variant="outline"
          className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          {label}
        </Badge>
      </span>
    )
  }
  const overridden = isOverridden(field)
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {overridden && <StatusLed tone="accent" className="self-center" />}
      <code
        className={cn(
          "font-mono text-xs wrap-anywhere",
          overridden ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {formatValue(field.value)}
      </code>
    </span>
  )
}

/** The search the page's filter field runs: key, env var, section title or description. */
export function fieldMatches(field: SettingFieldView, section: SettingsSectionView, query: string): boolean {
  if (!query) return true
  return (
    field.key.toLowerCase().includes(query) ||
    (field.envVar ?? "").toLowerCase().includes(query) ||
    section.title.toLowerCase().includes(query) ||
    (field.description ?? "").toLowerCase().includes(query)
  )
}

/** Settings set from the environment, the page's denominator. */
export function envSettingCount(sections: readonly SettingsSectionView[]): number {
  return sections.reduce((n, s) => n + s.fields.filter((f) => f.envVar).length, 0)
}

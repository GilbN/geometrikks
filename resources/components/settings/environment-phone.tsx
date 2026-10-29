/**
 * Settings > Environment on a phone: one accordion instead of every setting
 * in full. "Changed from default" comes first and starts open, the real
 * groups start closed with their counts, and searching opens the groups
 * that match. Each setting is one line that taps open for its description,
 * default and env var.
 */
import { useState } from "react"
import { ChevronDown, Lock, Search, Settings2, SlidersHorizontal } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import {
  computedLabel,
  fieldMatches,
  formatValue,
  isOverridden,
  sectionIcons,
  ValueBlock,
} from "@/components/settings/environment-fields"
import type { SettingFieldView, SettingsSectionView } from "@/generated/api/types.gen"
import { cn } from "@/lib/utils"

const CHANGED = "changed"

interface Row {
  id: string
  field: SettingFieldView
  section: SettingsSectionView
}

export function EnvironmentPhone({ sections }: { sections: readonly SettingsSectionView[] }) {
  const [query, setQuery] = useState("")
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set([CHANGED]))
  // While searching every group with a match opens. Groups closed during a
  // search stay closed for that query only, and the open groups from before
  // the search come back when it is cleared.
  const [searchClosed, setSearchClosed] = useState<{ query: string; names: ReadonlySet<string> }>({
    query: "",
    names: new Set(),
  })
  const q = query.trim().toLowerCase()
  const closedNow = searchClosed.query === q ? searchClosed.names : new Set<string>()

  const rowsOf = (section: SettingsSectionView): Row[] =>
    section.fields
      .filter((field) => fieldMatches(field, section, q))
      .map((field) => ({ id: `${section.name}.${field.key}`, field, section }))
  const changed = sections.flatMap((section) => rowsOf(section).filter((row) => isOverridden(row.field)))
  const groups = [
    {
      name: CHANGED,
      title: "Changed from default",
      icon: SlidersHorizontal,
      rows: changed,
      changedCount: changed.length,
      showSection: true,
      description: undefined as string | null | undefined,
    },
    ...sections.map((section) => {
      const rows = rowsOf(section)
      return {
        name: section.name,
        title: section.title,
        icon: sectionIcons[section.name] ?? Settings2,
        rows,
        changedCount: rows.filter((row) => isOverridden(row.field)).length,
        showSection: false,
        description: section.description,
      }
    }),
  ].filter((group) => group.rows.length > 0)

  const toggle = (name: string, open: boolean) => {
    const update = (previous: ReadonlySet<string>, add: boolean) => {
      const next = new Set(previous)
      if (add) next.add(name)
      else next.delete(name)
      return next
    }
    if (q) setSearchClosed({ query: q, names: update(closedNow, !open) })
    else setOpenGroups((previous) => update(previous, open))
  }
  const settingCount = sections.reduce((n, section) => n + section.fields.length, 0)

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder={`Search ${settingCount} settings`}
          aria-label="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-11 bg-glass-card pl-9 backdrop-blur-[2px]"
        />
      </div>
      {groups.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No settings match "{query}".</p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-glass-card ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px]">
          {groups.map((group) => (
            <Collapsible
              key={group.name}
              open={q ? !closedNow.has(group.name) : openGroups.has(group.name)}
              onOpenChange={(open) => toggle(group.name, open)}
              className="border-b border-border/50 last:border-b-0"
            >
              <CollapsibleTrigger
                className={cn(
                  "group flex min-h-12.5 w-full items-center gap-3 px-3 text-left",
                  group.name === CHANGED && "bg-primary/10",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <group.icon className="size-4 text-primary" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.title}</span>
                {group.changedCount > 0 && group.name !== CHANGED && (
                  <span className="flex items-center gap-1 text-xs font-medium">
                    <StatusLed tone="accent" />
                    {group.changedCount}
                    <span className="sr-only"> changed</span>
                  </span>
                )}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {group.rows.length}
                  <span className="sr-only"> settings</span>
                </span>
                <ChevronDown
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                {group.description && (
                  <p className="border-t border-border/40 px-3 pt-2 text-xs text-muted-foreground">{group.description}</p>
                )}
                <ul className={cn(!group.description && "border-t border-border/40")}>
                  {group.rows.map((row) => (
                    <SettingRow key={row.id} row={row} showSection={group.showSection} />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      )}
    </div>
  )
}

function SettingRow({ row, showSection }: { row: Row; showSection: boolean }) {
  const { field, section } = row
  const overridden = isOverridden(field)
  return (
    <li className="border-b border-border/30 last:border-b-0">
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {field.key}
              {overridden && <span className="sr-only">, changed from default</span>}
            </span>
            {showSection && <span className="block text-xs text-muted-foreground">{section.title}</span>}
          </span>
          <span className="flex max-w-[45%] items-center gap-1.5">
            {overridden && !showSection && <StatusLed tone="accent" />}
            {field.isSecret ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Lock aria-hidden className="size-3" />
                {field.value !== null && field.value !== undefined ? "set" : "not set"}
              </span>
            ) : (
              <>
                <code
                  className={cn(
                    "truncate font-mono text-xs",
                    overridden ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {formatValue(field.value ?? field.computedValue)}
                </code>
                {/* A value the app worked out, not one that was configured. */}
                {(field.value === null || field.value === undefined) &&
                  field.computedValue !== null &&
                  field.computedValue !== undefined && (
                    <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                      {computedLabel[field.computedSource ?? ""] ?? "computed"}
                    </span>
                  )}
              </>
            )}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-3 pb-3 text-xs">
            {field.description && <p className="text-muted-foreground">{field.description}</p>}
            <ValueBlock field={field} />
            {overridden && !field.isSecret && (
              <p className="text-muted-foreground">
                default: <code className="font-mono">{formatValue(field.default)}</code>
              </p>
            )}
            {field.envVar && <MonoChip>{field.envVar}</MonoChip>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

import { useEffect, useState } from "react"
import { ChevronDown, ExternalLink } from "lucide-react"
import type { ChangelogEntry, ChangelogRelease, ChangelogSection } from "@/generated/api/types.gen"
import { useAbout, useChangelog } from "@/lib/queries"
import { currentBuildKey, saveSeenBuild } from "@/lib/changelog-seen"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { MonoChip } from "@/components/settings/status-led"
import { InlineMarkdown } from "@/components/settings/inline-markdown"

const KIND_CLASSES: Record<string, string> = {
  Added: "border-emerald-500/40 text-emerald-500",
  Changed: "border-primary/40 text-primary",
  Fixed: "border-sky-500/40 text-sky-500",
  Deprecated: "border-amber-500/40 text-amber-500",
  Removed: "border-red-500/40 text-red-500",
  Security: "border-red-500/40 text-red-500",
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" })

function Entry({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="text-sm leading-relaxed text-foreground/90">
      <InlineMarkdown text={entry.text} />
      {entry.children.length > 0 && (
        <ul className="mt-1 list-disc space-y-1 pl-5 marker:text-muted-foreground/60">
          {entry.children.map((child, index) => (
            <li key={index}>
              <InlineMarkdown text={child} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function Section({ section }: { section: ChangelogSection }) {
  return (
    <div className="space-y-2">
      <Badge variant="outline" className={cn("font-semibold uppercase tracking-[0.06em]", KIND_CLASSES[section.kind])}>
        {section.kind}
      </Badge>
      <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground/60">
        {section.entries.map((entry, index) => (
          <Entry key={index} entry={entry} />
        ))}
      </ul>
    </div>
  )
}

function ReleaseCard({
  release,
  thisBuild,
  open,
  onOpenChange,
}: {
  release: ChangelogRelease
  thisBuild: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const count = release.sections.reduce((sum, section) => sum + section.entries.length, 0)
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <Card size="sm" className={cn(thisBuild && "ring-primary/40")}>
        {/* The GitHub link sits beside the trigger, not inside it: a link
            inside a button is invalid and would toggle the card. */}
        <CardHeader className="flex flex-row items-center gap-2">
          <CollapsibleTrigger className="group/release flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-left">
            <MonoChip className="text-[13px] text-foreground">
              {release.unreleased ? "Unreleased" : `v${release.version}`}
            </MonoChip>
            {release.date && (
              <span className="text-sm text-muted-foreground">{dateFormat.format(new Date(release.date))}</span>
            )}
            {thisBuild && <Badge>This build</Badge>}
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {count} {count === 1 ? "change" : "changes"}
              <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]/release:rotate-180" />
            </span>
          </CollapsibleTrigger>
          {release.url && (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" asChild>
              <a
                href={release.url}
                target="_blank"
                rel="noreferrer"
                aria-label={release.unreleased ? "Unreleased changes on GitHub" : `v${release.version} on GitHub`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-5 pt-0">
            {release.sections.map((section) => (
              <Section key={section.kind} section={section} />
            ))}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

export function ChangelogPage() {
  const { data, isLoading, isError, refetch } = useChangelog()
  const { data: about } = useAbout()
  const buildKey = about ? currentBuildKey(about.app) : null
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  // Opening this page is what "seen" means.
  useEffect(() => {
    if (buildKey) saveSeenBuild(buildKey)
  }, [buildKey])

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
          <span className="text-sm text-muted-foreground">The changelog could not be loaded.</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (isLoading || !data || !about) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  }

  const releases = data.releases.filter((release) => release.sections.length > 0)
  // The changelog ships from the same checkout as the code, so a non-empty
  // Unreleased section means this build is ahead of the last release and
  // contains those changes, whatever the image tag says.
  const ahead = releases.some((release) => release.unreleased)
  const isThisBuild = (release: ChangelogRelease) =>
    ahead ? release.unreleased : release.version === about.app.version
  const isOpen = (release: ChangelogRelease) => overrides[release.version] ?? isThisBuild(release)
  const setAll = (open: boolean) =>
    setOverrides(Object.fromEntries(releases.map((release) => [release.version, open])))

  if (releases.length === 0) {
    return (
      <Card>
        <CardContent className="py-5 text-sm text-muted-foreground">
          This install ships without a changelog.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
          Expand all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAll(false)}>
          Collapse all
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`${about.links.repository}/blob/main/CHANGELOG.md`} target="_blank" rel="noreferrer">
            View on GitHub
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
      {releases.map((release) => (
        <ReleaseCard
          key={release.version}
          release={release}
          thisBuild={isThisBuild(release)}
          open={isOpen(release)}
          onOpenChange={(open) => setOverrides((prev) => ({ ...prev, [release.version]: open }))}
        />
      ))}
    </div>
  )
}

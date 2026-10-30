import { Link } from "@tanstack/react-router"
import { ChevronRight, Network, Trash2 } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { HeadIdentityView, InstanceView } from "@/generated/api/types.gen"
import { useDeleteInstance, useInstances } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { displayVersion } from "@/lib/version"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import { relativeTime } from "@/components/settings/status-logic"
import { SectionIcon } from "@/components/settings/status-overview"
import {
  agentInstances,
  canRemove,
  deepLinkScrollDelta,
  instanceStatusLabel,
  instanceTone,
  instancesErrorState,
  shortVersion,
  versionDriftText,
  versionTone,
} from "@/components/settings/agents-logic"
import {
  GeoipFacts,
  IngestionFacts,
  InstanceFacts,
  JobsList,
  LastErrorBlock,
  ProblemCard,
  ServerLocationsList,
  SourcesList,
} from "@/components/settings/agents-detail"
import { AgentDrawer, AgentList } from "@/components/settings/agents-phone"
import { NARROW_TABLE_WIDTH, useNarrowLayout } from "@/components/data/narrow-layout"

const AGENT_DOCS_URL = "https://github.com/GilbN/geometrikks/blob/main/README.md#multi-source-setup"

const COLUMN_COUNT = 7

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>
}

function InstanceDetail({
  instance,
  head,
  now,
  checkedAt,
}: {
  instance: InstanceView
  head: HeadIdentityView
  now: number
  checkedAt: number
}) {
  return (
    <div className="space-y-4 py-2 whitespace-normal">
      {!instance.checkingIn && (
        <p className="text-xs text-muted-foreground">
          These details come from its last heartbeat, {relativeTime(instance.lastSeen, checkedAt)}.
        </p>
      )}

      <div className="space-y-2">
        <SectionHeading>Problems</SectionHeading>
        {instance.problems.length === 0 ? (
          <p className="text-xs text-muted-foreground">No problems.</p>
        ) : (
          instance.problems.map((problem) => <ProblemCard key={problem.id} problem={problem} />)
        )}
      </div>

      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <div className="space-y-2">
          <SectionHeading>Instance</SectionHeading>
          <InstanceFacts instance={instance} head={head} now={now} />
        </div>

        <div className="space-y-2">
          <SectionHeading>Ingestion</SectionHeading>
          <IngestionFacts instance={instance} now={now} />
        </div>

        <div className="space-y-2">
          <SectionHeading>GeoIP</SectionHeading>
          <GeoipFacts instance={instance} now={now} />
        </div>

        <div className="space-y-2">
          <SectionHeading>Scheduled jobs</SectionHeading>
          <JobsList instance={instance} now={now} />
        </div>
      </div>

      <div className="space-y-2">
        <SectionHeading>Sources</SectionHeading>
        <SourcesList instance={instance} />
      </div>

      <div className="space-y-2">
        <SectionHeading>Server locations</SectionHeading>
        <ServerLocationsList instance={instance} now={now} />
      </div>

      <div className="space-y-2">
        <SectionHeading>Last error</SectionHeading>
        <LastErrorBlock instance={instance} />
      </div>
    </div>
  )
}

function RemoveInstanceButton({
  instanceName,
  onRemoved,
}: {
  instanceName: string
  onRemoved: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const removedRef = useRef(false)
  const deleteInstanceMutation = useDeleteInstance()
  const pending = deleteInstanceMutation.isPending
  // React bubbles events out of the dialog's portal along the component
  // tree, so without this span every click in the dialog toggles the row.
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${instanceName}`}
            // The touch target grows to 40px; the margin keeps it from making
            // this row taller than rows without the button.
            className="text-muted-foreground hover:text-destructive pointer-coarse:-my-2.5"
          >
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // The trigger leaves with the removed row; focus the table heading instead.
            if (!removedRef.current) return
            event.preventDefault()
            onRemoved()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {instanceName} from the list?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes its heartbeat row. If {instanceName} is still running somewhere, it writes
              the row again within 30 seconds and comes back here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                // Stay open while the request runs; success closes it, failure leaves it up to retry.
                event.preventDefault()
                deleteInstanceMutation.mutate(instanceName, {
                  onSuccess: () => {
                    removedRef.current = true
                    setConfirming(false)
                  },
                  onError: () => toast.error(`Could not remove ${instanceName}. Try again.`),
                })
              }}
            >
              {pending ? "Removing" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  )
}

function FiveMinuteCell({ instance }: { instance: InstanceView }) {
  const lines = instance.payload?.lines5M
  const failed = instance.payload?.failed5M
  if (lines === null || lines === undefined) {
    return (
      <span className="text-muted-foreground" title="Needs 5 minutes of heartbeats">
        <span aria-hidden="true">-</span>
        <span className="sr-only">Needs 5 minutes of heartbeats</span>
      </span>
    )
  }
  return (
    <span className="tabular-nums">
      {lines.toLocaleString()}
      {(failed ?? 0) > 0 && <span className="text-red-500">, {failed?.toLocaleString()} failed</span>}
    </span>
  )
}

function InstanceRows({
  instance,
  head,
  open,
  onOpenChange,
  now,
  checkedAt,
  rowRef,
  onRemoved,
}: {
  instance: InstanceView
  head: HeadIdentityView
  open: boolean
  onOpenChange: (open: boolean) => void
  now: number
  checkedAt: number
  rowRef?: React.Ref<HTMLTableRowElement>
  onRemoved: () => void
}) {
  const drift = versionTone(instance, head)
  const driftText = versionDriftText(drift)
  const serverNames = instance.payload?.serverNames ?? []
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <TableBody className="border-b last:border-b-0">
        <TableRow ref={rowRef} className="cursor-pointer" onClick={() => onOpenChange(!open)}>
          <TableCell className="w-6">
            <StatusLed tone={instanceTone(instance)} />
            <span className="sr-only">{instanceStatusLabel(instance.status)}</span>
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground transition-transform motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                  <MonoChip className="text-foreground">{instance.instanceName}</MonoChip>
                </button>
              </CollapsibleTrigger>
              {instance.isSelf && (
                <Badge variant="outline" className="hidden sm:inline-flex">
                  this instance
                </Badge>
              )}
            </div>
          </TableCell>
          <TableCell
            className={cn(
              "tabular-nums",
              drift === "red" && "text-red-500",
              drift === "amber" && "text-amber-500",
            )}
          >
            <span title={driftText ?? undefined}>{displayVersion(instance.appVersion)}</span>
            {driftText && <span className="sr-only">, {driftText}</span>}
          </TableCell>
          <TableCell className="hidden text-muted-foreground md:table-cell">
            {serverNames.length > 0 ? serverNames.join(", ") : "-"}
          </TableCell>
          <TableCell className="hidden md:table-cell">
            <FiveMinuteCell instance={instance} />
          </TableCell>
          <TableCell className={cn("tabular-nums", instance.checkingIn ? "text-muted-foreground" : "text-red-500")}>
            <span title={instance.checkingIn ? undefined : "Not checking in"}>
              {relativeTime(instance.lastSeen, checkedAt)}
            </span>
            {!instance.checkingIn && <span className="sr-only">, not checking in</span>}
          </TableCell>
          <TableCell className="w-8 text-right">
            {canRemove(instance) && (
              <RemoveInstanceButton instanceName={instance.instanceName} onRemoved={onRemoved} />
            )}
          </TableCell>
        </TableRow>
        <CollapsibleContent asChild>
          <TableRow className="bg-muted/20 hover:bg-muted/20">
            <TableCell />
            <TableCell colSpan={COLUMN_COUNT - 1} className="pr-4">
              {/* Zero width, so the details wrap to the columns' width
                  instead of widening the table past its card. */}
              <div className="w-0 min-w-full">
                <InstanceDetail instance={instance} head={head} now={now} checkedAt={checkedAt} />
              </div>
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </TableBody>
    </Collapsible>
  )
}

export function AgentsOverview({ focusInstance }: { focusInstance?: string }) {
  const { data, isError } = useInstances()
  const state = instancesErrorState(isError, data)
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(focusInstance ? [focusInstance] : []),
  )
  const [drawer, setDrawer] = useState<{ instanceName: string | null; open: boolean }>({
    instanceName: null,
    open: false,
  })
  // The row that opened the drawer gets focus back when it closes.
  const openerRef = useRef<HTMLElement | null>(null)
  const focusRowRef = useRef<HTMLTableRowElement>(null)
  const handledFocusFor = useRef<string | undefined>(undefined)
  const headingRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const layoutElementRef = useRef<HTMLDivElement | null>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()
  const setLayoutElement = useCallback(
    (element: HTMLDivElement | null) => {
      layoutElementRef.current = element
      layoutRef(element)
    },
    [layoutRef],
  )
  const setDrawerOpen = useCallback(
    (open: boolean) => setDrawer((previous) => (previous.open === open ? previous : { ...previous, open })),
    [],
  )

  useEffect(() => {
    if (!focusInstance) return
    setExpanded((previous) => (previous.has(focusInstance) ? previous : new Set(previous).add(focusInstance)))
  }, [focusInstance])

  // Measured here rather than read from `narrow`, which settles only after
  // this first render. A deep link opens the drawer on a narrow card and
  // scrolls to the expanded row on a wide one.
  useLayoutEffect(() => {
    if (state !== "ready" || !focusInstance || handledFocusFor.current === focusInstance) return
    const layoutElement = layoutElementRef.current
    if (!layoutElement) return
    handledFocusFor.current = focusInstance
    if (layoutElement.clientWidth < NARROW_TABLE_WIDTH) {
      openerRef.current = null
      setDrawer({ instanceName: focusInstance, open: true })
      return
    }
    const row = focusRowRef.current
    const card = cardRef.current
    if (!row || !card) return
    const scroller = row.closest("main")
    const viewport = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
    const rowRect = row.getBoundingClientRect()
    const scrollDelta = deepLinkScrollDelta({
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      cardTop: card.getBoundingClientRect().top,
      rowTop: rowRect.top,
      rowBottom: rowRect.bottom,
      detailBottom: (row.parentElement ?? row).getBoundingClientRect().bottom,
    })
    if (scrollDelta > 0) (scroller ?? window).scrollBy({ top: scrollDelta })
  }, [state, focusInstance])

  if (state === "loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (state === "error" || !data) {
    return (
      <Card className="border-l-2 border-l-red-500">
        <CardContent className="space-y-1 pt-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <StatusLed tone="red" />
            Could not load the agent list.
          </div>
          <p className="text-xs text-muted-foreground">
            The request failed, so this page cannot tell which agents are checking in. If the
            database is down,{" "}
            <Link to="/settings/status" className="underline underline-offset-2">
              Settings &gt; Status
            </Link>{" "}
            says so. This page tries again every 30 seconds.
          </p>
        </CardContent>
      </Card>
    )
  }

  const now = Date.now()
  const checkedAt = Date.parse(data.checkedAt)
  const agentCount = agentInstances(data).length
  const setInstanceOpen = (instanceName: string, open: boolean) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(instanceName)
      else next.delete(instanceName)
      return next
    })
  const drawerInstance = data.instances.find((instance) => instance.instanceName === drawer.instanceName) ?? null

  return (
    <div className="space-y-4">
      <Card ref={cardRef} className={cn(narrow && "gap-0 py-0")}>
        <CardHeader className={cn(narrow ? "px-4 pt-3.5 pb-2.5" : "pb-3")}>
          <div className="flex items-center gap-3">
            <SectionIcon icon={Network} />
            <div className="min-w-0">
              <CardTitle
                ref={headingRef}
                tabIndex={-1}
                className={cn("outline-none", narrow ? "text-[15px] font-semibold" : "text-base")}
              >
                Instances
              </CardTitle>
              {narrow ? (
                <CardDescription className="text-xs">
                  Head <MonoChip className="whitespace-nowrap">{shortVersion(data.head.appVersion)}</MonoChip> ·
                  checked{" "}
                  {new Date(data.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </CardDescription>
              ) : (
                <CardDescription>
                  The head runs <MonoChip className="whitespace-nowrap">{displayVersion(data.head.appVersion)}</MonoChip>{" "}
                  on migration <MonoChip>{data.head.schemaRevision}</MonoChip>. Checked{" "}
                  {new Date(data.checkedAt).toLocaleTimeString()}, refreshed every 30 seconds.
                </CardDescription>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Switches on the card's width, not the viewport's, at the same 50rem
              as the scheduler: from md up the sidebar and settings nav leave
              the card narrower than the table. */}
          <div ref={setLayoutElement}>
            {narrow ? (
              <div className="-mx-6">
                <AgentList
                  instances={data.instances}
                  head={data.head}
                  checkedAt={checkedAt}
                  onOpen={(instanceName, opener) => {
                    openerRef.current = opener
                    setDrawer({ instanceName, open: true })
                  }}
                />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6">
                      <span className="sr-only">Status</span>
                    </TableHead>
                    <TableHead>Instance</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead className="hidden md:table-cell">Servers</TableHead>
                    <TableHead className="hidden md:table-cell">Lines, last 5 min</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead className="w-8">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                {data.instances.map((instance) => (
                  <InstanceRows
                    key={instance.instanceName}
                    instance={instance}
                    head={data.head}
                    open={expanded.has(instance.instanceName)}
                    onOpenChange={(open) => setInstanceOpen(instance.instanceName, open)}
                    now={now}
                    checkedAt={checkedAt}
                    rowRef={instance.instanceName === focusInstance ? focusRowRef : undefined}
                    onRemoved={() => headingRef.current?.focus()}
                  />
                ))}
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {narrow && (
        <AgentDrawer
          instance={drawerInstance}
          open={drawer.open}
          onOpenChange={setDrawerOpen}
          head={data.head}
          checkedAt={checkedAt}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // A deep link has no opener, and a removed agent takes its row along.
            const row = layoutElementRef.current?.querySelector<HTMLElement>(
              `[data-instance-row="${CSS.escape(drawer.instanceName ?? "")}"]`,
            )
            const target = openerRef.current?.isConnected ? openerRef.current : (row ?? headingRef.current)
            target?.focus()
          }}
        />
      )}

      {agentCount === 0 && (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-sm font-medium">No agents yet</p>
            <p className="text-xs text-muted-foreground">
              An agent is a GeoMetrikks container started with <MonoChip>APP_MODE=agent</MonoChip>{" "}
              on another host. It tails that host's proxy logs and writes to this database, so its
              traffic appears on the map and in analytics. Agents show up here once they run a
              release that writes heartbeats, within 30 seconds of starting.
            </p>
            <a
              href={AGENT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline underline-offset-2"
            >
              Set up an agent
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

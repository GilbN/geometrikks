/**
 * Settings > Agents on a card narrower than the table: one two-line row per
 * instance that says what is wrong in words, and a bottom drawer with the
 * problems and each detail section for the row that was tapped.
 */
import { useEffect, useId, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react"
import type { HeadIdentityView, InstanceView } from "@/generated/api/types.gen"
import { useDeleteInstance } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import { relativeTime } from "@/components/settings/status-logic"
import {
  canRemove,
  type DetailSection,
  type DetailSectionId,
  instanceDetailSections,
  instanceHeaderLine,
  instanceRowLine,
  instanceStatusLabel,
  instanceTone,
  removeFailureMessage,
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
  PartsLine,
  ProblemCard,
  ServerLocationsList,
  SourcesList,
} from "@/components/settings/agents-detail"

const rowBadgeClasses = "rounded-md px-1.5 text-[11px]"

const driftBadgeClasses = {
  red: "border-red-500/45 text-red-500",
  amber: "border-amber-500/45 text-amber-500",
} as const

export function AgentList({
  instances,
  head,
  checkedAt,
  onOpen,
}: {
  instances: readonly InstanceView[]
  head: HeadIdentityView
  checkedAt: number
  onOpen: (instanceName: string, opener: HTMLElement) => void
}) {
  return (
    <ul className="border-t">
      {instances.map((instance) => {
        const drift = versionTone(instance, head)
        return (
          <li key={instance.instanceName} className="border-b last:border-b-0">
            <button
              type="button"
              data-instance-row={instance.instanceName}
              onClick={(event) => onOpen(instance.instanceName, event.currentTarget)}
              className="flex min-h-[62px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <StatusLed tone={instanceTone(instance)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <MonoChip className="min-w-0 truncate text-foreground">{instance.instanceName}</MonoChip>
                  {instance.isSelf && (
                    <Badge variant="outline" className={cn(rowBadgeClasses, "text-muted-foreground")}>
                      this instance
                    </Badge>
                  )}
                  {drift && (
                    <Badge variant="outline" className={cn(rowBadgeClasses, driftBadgeClasses[drift])}>
                      {shortVersion(instance.appVersion)}
                      <span className="sr-only">, {versionDriftText(drift)}</span>
                    </Badge>
                  )}
                  <span
                    className={cn(
                      "ml-auto shrink-0 pl-1 text-xs tabular-nums",
                      instance.checkingIn ? "text-muted-foreground" : "text-red-500",
                    )}
                  >
                    {relativeTime(instance.lastSeen, checkedAt)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {/* A healthy row's line already starts with "Healthy". */}
                  {instance.status !== "ok" && (
                    <span className="sr-only">{instanceStatusLabel(instance.status)}: </span>
                  )}
                  <PartsLine parts={instanceRowLine(instance)} />
                </span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function AgentDrawer({
  instance,
  open,
  onOpenChange,
  head,
  checkedAt,
  onCloseAutoFocus,
}: {
  instance: InstanceView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  head: HeadIdentityView
  checkedAt: number
  onCloseAutoFocus: (event: Event) => void
}) {
  // The last instance stays on screen while the drawer slides away.
  const shownRef = useRef<InstanceView | null>(null)
  if (instance) shownRef.current = instance
  const shown = instance ?? shownRef.current
  // An agent removed or gone while its drawer is open closes the drawer,
  // rather than leave its details on screen.
  const gone = open && instance === null
  useEffect(() => {
    if (gone) onOpenChange(false)
  }, [gone, onOpenChange])

  return (
    <Drawer open={open} onOpenChange={onOpenChange} autoFocus>
      <DrawerContent
        className="data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-92px)] md:mx-auto md:w-full md:max-w-2xl"
        onOpenAutoFocus={(event) => {
          // The title rather than the first button, so a deep link doesn't
          // open with a focus ring on Close.
          event.preventDefault()
          const content = event.currentTarget
          if (content instanceof HTMLElement) content.querySelector<HTMLElement>("[data-slot='drawer-title']")?.focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {shown && <AgentDetail key={shown.instanceName} instance={shown} head={head} checkedAt={checkedAt} />}
      </DrawerContent>
    </Drawer>
  )
}

function AgentDetail({
  instance,
  head,
  checkedAt,
}: {
  instance: InstanceView
  head: HeadIdentityView
  checkedAt: number
}) {
  const sections = instanceDetailSections(instance, checkedAt)
  const headerGroups = instanceHeaderLine(instance, head, checkedAt)
  const problemCount = instance.problems.length
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [announcement, setAnnouncement] = useState("")
  // An agent that checks in again loses its Remove button, and with it the
  // focus if that is where it was; the drawer's focus trap would leave it on
  // the drawer itself.
  const wasCheckingIn = useRef(instance.checkingIn)
  useEffect(() => {
    if (!wasCheckingIn.current && instance.checkingIn) {
      setAnnouncement(`${instance.instanceName} is checking in again.`)
      requestAnimationFrame(() => {
        const title = titleRef.current
        const active = document.activeElement
        const content = title?.closest("[data-slot='drawer-content']")
        if (!active || active === document.body || active === content) title?.focus()
      })
    }
    wasCheckingIn.current = instance.checkingIn
  }, [instance.checkingIn, instance.instanceName])
  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <DrawerHeader className="flex-row items-start gap-2 pb-3 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
        <div className="min-w-0 flex-1 space-y-1">
          <DrawerTitle ref={titleRef} tabIndex={-1} className="flex items-center gap-2 outline-none">
            <StatusLed tone={instanceTone(instance)} />
            <MonoChip className="min-w-0 truncate text-[13px] text-foreground">{instance.instanceName}</MonoChip>
            <span className="sr-only">, {instanceStatusLabel(instance.status)}</span>
          </DrawerTitle>
          <DrawerDescription className="text-xs">
            {headerGroups.map((group, groupIndex) => (
              <span key={groupIndex}>
                {groupIndex > 0 && " · "}
                {group.map((part, partIndex) => (
                  <span
                    key={partIndex}
                    className={cn(
                      part.tone === "red" && "text-red-500",
                      part.tone === "amber" && "text-amber-500",
                      part.nowrap && "whitespace-nowrap",
                    )}
                  >
                    {part.text}
                  </span>
                ))}
              </span>
            ))}
          </DrawerDescription>
        </div>
        <DrawerClose asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" className="-mt-1 -mr-2 shrink-0">
            <X className="size-[18px]" />
          </Button>
        </DrawerClose>
      </DrawerHeader>
      <div className="overflow-y-auto overscroll-contain px-4 pb-6">
        {problemCount > 1 && (
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{problemCount} problems</h3>
        )}
        {problemCount > 0 && (
          <div className="grid gap-2">
            {instance.problems.map((problem) => (
              <ProblemCard
                key={problem.id}
                problem={problem}
                action={
                  problem.id === "instance-not-checking-in" && canRemove(instance) ? (
                    <RemoveFromList instanceName={instance.instanceName} />
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
        <div className={cn(problemCount > 0 && "mt-3.5")}>
          {sections.map((section) => (
            <SectionRow key={section.id} section={section}>
              <SectionBody id={section.id} instance={instance} head={head} now={checkedAt} />
            </SectionRow>
          ))}
        </div>
      </div>
    </>
  )
}

function SectionRow({ section, children }: { section: DetailSection; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex min-h-[52px] w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <StatusLed tone={section.tone} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium">{section.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              <PartsLine parts={section.summary} />
            </span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3 pl-5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function SectionBody({
  id,
  instance,
  head,
  now,
}: {
  id: DetailSectionId
  instance: InstanceView
  head: HeadIdentityView
  now: number
}) {
  switch (id) {
    case "ingestion":
      return <IngestionFacts instance={instance} now={now} />
    case "last-error":
      return <LastErrorBlock instance={instance} />
    case "sources":
      return <SourcesList instance={instance} />
    case "jobs":
      return <JobsList instance={instance} now={now} />
    case "geoip":
      return <GeoipFacts instance={instance} now={now} />
    case "instance":
      return <InstanceFacts instance={instance} head={head} now={now} />
    case "server-locations":
      return <ServerLocationsList instance={instance} now={now} />
  }
}

/** Remove, confirmed in place. vaul bundles its own Radix Dialog, which keeps
 *  focus out of an AlertDialog opened from inside the drawer. */
function RemoveFromList({ instanceName }: { instanceName: string }) {
  const [confirming, setConfirming] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const deleteInstanceMutation = useDeleteInstance()
  const pending = deleteInstanceMutation.isPending
  const keepRef = useRef<HTMLButtonElement>(null)
  const removeRef = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  // Focus goes back to Remove from the list when the confirmation closes;
  // otherwise the drawer's focus trap drops it at the top of the drawer.
  const wasConfirming = useRef(false)
  useEffect(() => {
    if (wasConfirming.current && !confirming) removeRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  const remove = () => {
    if (pending) return
    setRemoveError(null)
    deleteInstanceMutation.mutate(instanceName, {
      onError: (error) => {
        // A 404 needs no message, since the refetch closes the drawer.
        const message = removeFailureMessage(error, instanceName)
        if (!message) return
        setRemoveError(message)
        requestAnimationFrame(() => keepRef.current?.focus())
      },
    })
  }

  if (!confirming) {
    return (
      <div className="space-y-1.5 pt-0.5">
        <Button
          ref={removeRef}
          type="button"
          variant="outline"
          className="border-destructive/45 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive dark:border-destructive/45 dark:bg-destructive/10 dark:hover:bg-destructive/20"
          onClick={() => {
            setRemoveError(null)
            setConfirming(true)
          }}
        >
          <Trash2 />
          Remove from the list
        </Button>
        <p className="text-xs text-muted-foreground">
          Shut it down on purpose? Remove it. If it still runs somewhere, it comes back within 30 seconds.
        </p>
      </div>
    )
  }

  // aria-disabled rather than disabled while the request runs, since a
  // disabled button drops focus out of the drawer to the page.
  return (
    <div
      role="group"
      aria-label={`Remove ${instanceName} from the list?`}
      aria-describedby={descriptionId}
      className="space-y-2 rounded-md border border-border/60 p-2 text-xs"
    >
      <p id={descriptionId} className="text-muted-foreground">
        Remove {instanceName} from the list? This deletes its heartbeat row. If {instanceName} is still
        running somewhere, it writes the row again within 30 seconds and comes back here.
      </p>
      {removeError && (
        <p role="alert" className="text-destructive">
          {removeError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          ref={keepRef}
          type="button"
          size="sm"
          variant="outline"
          autoFocus
          // Closing mid-request would hide whether the removal worked.
          aria-disabled={pending}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!pending) setConfirming(false)
          }}
        >
          Keep
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          aria-disabled={pending}
          className="aria-disabled:opacity-50"
          onClick={remove}
        >
          {pending ? "Removing" : "Remove"}
        </Button>
      </div>
    </div>
  )
}

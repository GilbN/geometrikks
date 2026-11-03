import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useIsMutating, useQueryClient } from "@tanstack/react-query"
import { Link, useBlocker } from "@tanstack/react-router"
import { KeyRound, Plus, X } from "lucide-react"
import { toast } from "sonner"
import type { ApiKeyView, CreatedApiKey } from "@/lib/api"
import { queryKeys, useApiKeys, useRevokeApiKey } from "@/lib/queries"
import { cn } from "@/lib/utils"
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
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import { SectionIcon } from "@/components/settings/status-overview"
import { ApiKeyCreateForm, ApiKeyReveal } from "@/components/settings/api-key-create"
import { ApiKeyScopeBadge, UsageDot } from "@/components/settings/api-key-status"
import { ApiKeyDrawer, ApiKeyList, focusDrawerTitle } from "@/components/settings/api-keys-phone"
import {
  apiErrorMessage,
  createdKeyLine,
  expiryShort,
  isNotFoundError,
  lastUsedDetail,
  lastUsedLabel,
  lastUsedShort,
  revokeConfirmText,
  revokeVerb,
  usageTone,
} from "@/components/settings/api-keys-logic"

/** The dot and short text are visual; screen readers get the full sentence. */
function LastUsedCell({ apiKey, now }: { apiKey: ApiKeyView; now: number }) {
  const detail = lastUsedDetail(apiKey, now)
  const label = (
    <span className="inline-flex items-center gap-2">
      <UsageDot tone={usageTone(apiKey, now)} />
      <span aria-hidden="true">{lastUsedShort(apiKey, now)}</span>
      <span className="sr-only">{detail ?? lastUsedLabel(apiKey, now)}</span>
    </span>
  )
  if (!detail) return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent aria-hidden="true">{detail}</TooltipContent>
    </Tooltip>
  )
}

function RevokeKeyButton({ apiKey, onRevoked }: { apiKey: ApiKeyView; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const revokedRef = useRef(false)
  const revokeApiKeyMutation = useRevokeApiKey()
  const pending = revokeApiKeyMutation.isPending
  const verb = revokeVerb(apiKey)
  return (
    <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`${verb} ${apiKey.name}`}>
          {verb}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!revokedRef.current) return
          event.preventDefault()
          onRevoked()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {apiKey.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>{revokeConfirmText(apiKey)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              revokeApiKeyMutation.mutate(apiKey.id, {
                onSuccess: () => {
                  revokedRef.current = true
                  setConfirming(false)
                },
                onError: (error) => {
                  if (isNotFoundError(error)) {
                    revokedRef.current = true
                    setConfirming(false)
                    return
                  }
                  toast.error(apiErrorMessage(error, `Could not ${verb.toLowerCase()} ${apiKey.name}. Try again.`))
                },
              })
            }}
          >
            {pending ? (apiKey.expired ? "Removing" : "Revoking") : verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const LEAVE_REVEAL_TITLE = "Leave without the key?"
const LEAVE_REVEAL_TEXT =
  "The key is shown only once. If you leave now, you will have to revoke it and create a new one."

function LeaveRevealConfirm({ open, onStay, onLeave }: { open: boolean; onStay: () => void; onLeave: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && onStay()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{LEAVE_REVEAL_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{LEAVE_REVEAL_TEXT}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault()
              onLeave()
            }}
          >
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The drawer asks in place. An AlertDialog over vaul's drawer loses focus
 *  to the drawer's own focus trap, as RevokeInDrawer notes. */
function LeaveRevealInDrawer({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const titleId = useId()
  const textId = useId()
  const confirmRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    confirmRef.current?.scrollIntoView({ block: "nearest" })
  }, [])
  return (
    <div
      ref={confirmRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        onStay()
      }}
      className="mb-4 space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/[0.07] p-3 text-[12.5px] leading-relaxed"
    >
      <p id={titleId} className="font-semibold">
        {LEAVE_REVEAL_TITLE}
      </p>
      <p id={textId}>{LEAVE_REVEAL_TEXT}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" autoFocus className="flex-1" onClick={onStay}>
          Stay
        </Button>
        <Button type="button" variant="destructive" className="flex-1" onClick={onLeave}>
          Leave
        </Button>
      </div>
    </div>
  )
}

/**
 * The Create key button and its dialog, or its bottom drawer on a narrow
 * card: the form, then the one-time reveal.
 */
export function CreateApiKey({ narrow, triggerRef }: { narrow: boolean; triggerRef?: React.Ref<HTMLButtonElement> }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  // Fixed while open, so a rotated tablet doesn't remount the form mid-request.
  const [drawerWhileOpen, setDrawerWhileOpen] = useState(narrow)
  // Closing or leaving the page mid-request would unmount the form and lose
  // the only response that carries the key. `creating` re-renders a tick
  // after the form shows Creating, so the guards ask the cache directly.
  const creating = useIsMutating({ mutationKey: queryKeys.auth.createApiKey }) > 0
  const queryClient = useQueryClient()
  const creatingNow = useCallback(
    () => queryClient.isMutating({ mutationKey: queryKeys.auth.createApiKey }) > 0,
    [queryClient],
  )
  useBlocker({ shouldBlockFn: creatingNow, enableBeforeUnload: creatingNow })
  // Leaving the reveal throws the key away for good, so Back and links ask first.
  const drawerTitleRef = useRef<HTMLHeadingElement>(null)
  const revealingRef = useRef(false)
  revealingRef.current = open && created !== null
  const revealingNow = useCallback(() => revealingRef.current, [])
  const leaveBlocker = useBlocker({ shouldBlockFn: revealingNow, enableBeforeUnload: revealingNow, withResolver: true })
  const leaveReveal = () => {
    revealingRef.current = false
    setOpen(false)
    setCreated(null)
    leaveBlocker.proceed?.()
  }
  const askingToLeave = leaveBlocker.status === "blocked" && created !== null
  const stayOnReveal = () => leaveBlocker.reset?.()
  // Done while the leave question is up answers it: the user has the key and asked to go.
  const finishReveal = () => (askingToLeave ? leaveReveal() : setOpen(false))
  const strandedBlock = leaveBlocker.status === "blocked" && created === null
  useEffect(() => {
    if (strandedBlock) leaveBlocker.reset?.()
  }, [strandedBlock, leaveBlocker])

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen && creatingNow()) return
    if (nextOpen) setDrawerWhileOpen(narrow)
    setOpen(nextOpen)
  }
  const inDrawer = open ? drawerWhileOpen : narrow
  const createButton = (
    <Button ref={triggerRef} type="button">
      <Plus />
      Create key
    </Button>
  )

  if (inDrawer) {
    return (
      // A swipe or a tap beside the reveal would throw the key away, so only Done closes it.
      <Drawer open={open} onOpenChange={changeOpen} dismissible={!creating && !created} autoFocus>
        <DrawerTrigger asChild>{createButton}</DrawerTrigger>
        <DrawerContent
          className="data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-92px)] md:mx-auto md:w-full md:max-w-lg"
          onOpenAutoFocus={focusDrawerTitle}
          onCloseAutoFocus={() => setCreated(null)}
        >
          <DrawerHeader className="flex-row items-start gap-2 pb-3 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
            <div className="min-w-0 flex-1 space-y-1">
              <DrawerTitle ref={drawerTitleRef} tabIndex={-1} className="text-[15px] outline-none">
                {created ? "Key created" : "Create API key"}
              </DrawerTitle>
              <DrawerDescription className="text-xs">
                {created ? createdKeyLine(created.apiKey) : "Name it after whatever will use it."}
              </DrawerDescription>
            </div>
            {!created && !creating && (
              <DrawerClose asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Close" className="-mt-1 -mr-2 shrink-0">
                  <X className="size-[18px]" />
                </Button>
              </DrawerClose>
            )}
          </DrawerHeader>
          <div className="overflow-y-auto overscroll-contain px-4 pb-6">
            {askingToLeave && (
              <LeaveRevealInDrawer
                onStay={() => {
                  stayOnReveal()
                  drawerTitleRef.current?.focus()
                }}
                onLeave={leaveReveal}
              />
            )}
            {created ? (
              <ApiKeyReveal created={created} onDone={finishReveal} />
            ) : (
              <ApiKeyCreateForm onCreated={setCreated} onCancel={() => changeOpen(false)} />
            )}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogTrigger asChild>{createButton}</DialogTrigger>
        <DialogContent
          className="sm:max-w-xl"
          showCloseButton={!creating}
          // Escape or a stray click beside the reveal would throw the key away.
          onEscapeKeyDown={(event) => (creatingNow() || created) && event.preventDefault()}
          onInteractOutside={(event) => (creatingNow() || created) && event.preventDefault()}
          onCloseAutoFocus={() => setCreated(null)}
        >
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>Key created</DialogTitle>
                <DialogDescription>{createdKeyLine(created.apiKey)}</DialogDescription>
              </DialogHeader>
              <ApiKeyReveal created={created} onDone={finishReveal} />
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  Name it after whatever will use it, so you know what breaks when you revoke it.
                </DialogDescription>
              </DialogHeader>
              <ApiKeyCreateForm onCreated={setCreated} onCancel={() => setOpen(false)} />
            </>
          )}
        </DialogContent>
      </Dialog>
      <LeaveRevealConfirm open={askingToLeave} onStay={stayOnReveal} onLeave={leaveReveal} />
    </>
  )
}

function ApiKeysTable({
  apiKeys,
  onRevoked,
}: {
  apiKeys: ApiKeyView[]
  onRevoked: (revokedKeyId: string) => void
}) {
  const now = Date.now()
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Name</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="w-px pr-4">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apiKeys.map((apiKey) => (
          <TableRow key={apiKey.id}>
            <TableCell className="max-w-64 truncate pl-4 font-medium" title={apiKey.name}>
              {apiKey.name}
            </TableCell>
            <TableCell>
              <ApiKeyScopeBadge apiKey={apiKey} />
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{apiKey.displayPrefix}…</TableCell>
            <TableCell>
              <LastUsedCell apiKey={apiKey} now={now} />
            </TableCell>
            <TableCell className={cn("tabular-nums", !apiKey.expiresAt && "text-muted-foreground")}>
              {expiryShort(apiKey)}
            </TableCell>
            <TableCell className="pr-4 text-right">
              <RevokeKeyButton apiKey={apiKey} onRevoked={() => onRevoked(apiKey.id)} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * `narrow` comes from the page, which measures the card's width so the
 * Create button above it can pick a drawer too. `focusOutsideList` takes
 * focus when a revoke empties the list and the card goes with it.
 */
export function ApiKeysOverview({ narrow, focusOutsideList }: { narrow: boolean; focusOutsideList: () => void }) {
  const { data, isError } = useApiKeys()
  const cardRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [drawer, setDrawer] = useState<{ keyId: string | null; open: boolean }>({ keyId: null, open: false })
  // The row that opened the drawer gets focus back when it closes.
  const openerRef = useRef<HTMLElement | null>(null)
  const revokedRef = useRef(false)
  const keyCount = data?.keys.length ?? 0
  const setDrawerOpen = useCallback(
    (open: boolean) => setDrawer((previous) => (previous.open === open ? previous : { ...previous, open })),
    [],
  )

  // A drawer left open while the list was gone, behind an error or a card
  // grown past the breakpoint, would otherwise pop back up on its own.
  const showingList = narrow && keyCount > 0
  const wasShowingList = useRef(false)
  useEffect(() => {
    if (wasShowingList.current && !showingList) setDrawer({ keyId: null, open: false })
    wasShowingList.current = showingList
  }, [showingList])

  if (!data && !isError) {
    return <Skeleton className="h-48 w-full rounded-xl" />
  }

  if (!data) {
    return (
      <Card className="border-l-2 border-l-red-500">
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <StatusLed tone="red" />
            Could not load the API keys.
          </div>
          <p className="text-xs text-muted-foreground">
            The request failed. If the database is down,{" "}
            <Link to="/settings/status" className="underline underline-offset-2">
              Settings &gt; Status
            </Link>{" "}
            says so. This page tries again every 30 seconds.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!data.available) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3">
          <SectionIcon icon={KeyRound} />
          <div className="space-y-1">
            <p className="text-sm font-medium">The API is already open</p>
            <p className="max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
              <MonoChip>APP_AUTH_DISABLED=true</MonoChip> turns off the built-in login, so every API route and live
              feed answers without a key. Keys only matter once the login is on again.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (data.keys.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3">
          <SectionIcon icon={KeyRound} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">No keys yet</p>
            <p className="max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
              Create one key for each script, monitor or dashboard that reads GeoMetrikks. Each tool sends its
              key in an <MonoChip>Authorization: Bearer</MonoChip> header, and revoking one key leaves the others
              working.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Holds whether or not the refetch without the revoked key has landed yet.
  const focusAfterRevoke = (revokedKeyId: string) =>
    data.keys.some((apiKey) => apiKey.id !== revokedKeyId) ? cardRef.current?.focus() : focusOutsideList()

  if (!narrow) {
    return (
      <Card ref={cardRef} tabIndex={-1} aria-label="API keys" className="gap-0 py-0 outline-none">
        <ApiKeysTable apiKeys={data.keys} onRevoked={focusAfterRevoke} />
      </Card>
    )
  }

  const now = Date.now()
  const drawerKey = data.keys.find((apiKey) => apiKey.id === drawer.keyId) ?? null
  return (
    <>
      <Card ref={cardRef} tabIndex={-1} aria-label="API keys" className="gap-0 overflow-hidden py-0 outline-none">
        <div ref={listRef}>
          <ApiKeyList
            apiKeys={data.keys}
            now={now}
            onOpen={(keyId, opener) => {
              openerRef.current = opener
              revokedRef.current = false
              setDrawer({ keyId, open: true })
            }}
          />
        </div>
      </Card>
      <ApiKeyDrawer
        apiKey={drawerKey}
        open={drawer.open}
        onOpenChange={setDrawerOpen}
        now={now}
        onRevoked={() => {
          revokedRef.current = true
          setDrawerOpen(false)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (revokedRef.current) {
            focusAfterRevoke(drawer.keyId ?? "")
            return
          }
          // A key revoked in another tab takes its row along, and the last one takes the card.
          const row = listRef.current?.querySelector<HTMLElement>(
            `[data-api-key-row="${CSS.escape(drawer.keyId ?? "")}"]`,
          )
          const target = [openerRef.current, row, cardRef.current].find((candidate) => candidate?.isConnected)
          if (target) target.focus()
          else focusOutsideList()
        }}
      />
    </>
  )
}

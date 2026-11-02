import { useRef, useState } from "react"
import { useIsMutating } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { KeyRound, Plus } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MonoChip, StatusLed } from "@/components/settings/status-led"
import { SectionIcon } from "@/components/settings/status-overview"
import { ApiKeyCreateForm, ApiKeyReveal } from "@/components/settings/api-key-create"
import {
  apiErrorMessage,
  createdKeyLine,
  expiryShort,
  formatKeyDate,
  lastUsedDetail,
  lastUsedLabel,
  lastUsedShort,
  scopeLabel,
  usageTone,
  type UsageTone,
} from "@/components/settings/api-keys-logic"
import { useNarrowLayout } from "@/components/data/narrow-layout"

/** Live glows green and stale amber, like the other status dots; idle is a plain grey dot. */
function UsageDot({ tone }: { tone: UsageTone }) {
  if (tone === "live") return <StatusLed tone="emerald" />
  if (tone === "stale") return <StatusLed tone="amber" />
  return <span className="inline-flex size-2 shrink-0 rounded-full bg-muted-foreground/60" />
}

export function ApiKeyScopeBadge({ apiKey }: { apiKey: ApiKeyView }) {
  if (apiKey.expired) {
    return (
      <Badge variant="outline" className="border-destructive/40 text-destructive">
        Expired
      </Badge>
    )
  }
  if (apiKey.scope === "read_write") {
    return (
      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400">
        {scopeLabel(apiKey.scope)}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {scopeLabel(apiKey.scope)}
    </Badge>
  )
}

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
  const verb = apiKey.expired ? "Remove" : "Revoke"
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
          <AlertDialogDescription>
            {apiKey.expired
              ? `It stopped working on ${formatKeyDate(apiKey.expiresAt ?? apiKey.createdAt)}. This takes it off the list.`
              : "Anything using it gets 401 from now on. This can't be undone."}
          </AlertDialogDescription>
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
                  if (error && typeof error === "object" && "status_code" in error && error.status_code === 404) {
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

/** The Create key button and its dialog: the form, then the one-time reveal. */
export function CreateApiKeyDialog({ triggerRef }: { triggerRef?: React.Ref<HTMLButtonElement> }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  // Closing mid-request would unmount the form and lose the only response
  // that carries the key.
  const creating = useIsMutating({ mutationKey: queryKeys.auth.createApiKey }) > 0
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen || !creating) && setOpen(nextOpen)}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button">
          <Plus />
          Create key
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={!creating}
        onEscapeKeyDown={(event) => creating && event.preventDefault()}
        // A stray click beside the reveal would throw the key away.
        onInteractOutside={(event) => (creating || created) && event.preventDefault()}
        onCloseAutoFocus={() => setCreated(null)}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>{createdKeyLine(created.apiKey)}</DialogDescription>
            </DialogHeader>
            <ApiKeyReveal created={created} onDone={() => setOpen(false)} />
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
  )
}

/** A narrow card drops the Key and Expires columns. */
function ApiKeysTable({
  apiKeys,
  narrow,
  onRevoked,
}: {
  apiKeys: ApiKeyView[]
  narrow: boolean
  onRevoked: () => void
}) {
  const now = Date.now()
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Name</TableHead>
          <TableHead>Scope</TableHead>
          {!narrow && <TableHead>Key</TableHead>}
          <TableHead>Last used</TableHead>
          {!narrow && <TableHead>Expires</TableHead>}
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
            {!narrow && (
              <TableCell className="font-mono text-xs text-muted-foreground">{apiKey.displayPrefix}…</TableCell>
            )}
            <TableCell>
              <LastUsedCell apiKey={apiKey} now={now} />
            </TableCell>
            {!narrow && (
              <TableCell className={cn("tabular-nums", !apiKey.expiresAt && "text-muted-foreground")}>
                {expiryShort(apiKey)}
              </TableCell>
            )}
            <TableCell className="pr-4 text-right">
              <RevokeKeyButton apiKey={apiKey} onRevoked={onRevoked} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** `focusOutsideList` takes focus when a revoke empties the list and the card goes with it. */
export function ApiKeysOverview({ focusOutsideList }: { focusOutsideList: () => void }) {
  const { data, isError } = useApiKeys()
  const cardRef = useRef<HTMLDivElement>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>()

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

  return (
    <Card ref={cardRef} tabIndex={-1} aria-label="API keys" className="gap-0 py-0 outline-none">
      <div ref={layoutRef}>
        <ApiKeysTable
          apiKeys={data.keys}
          narrow={narrow}
          onRevoked={() => (data.keys.length > 1 ? cardRef.current?.focus() : focusOutsideList())}
        />
      </div>
    </Card>
  )
}

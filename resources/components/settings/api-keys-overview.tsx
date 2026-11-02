import { useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { KeyRound, Plus } from "lucide-react"
import { toast } from "sonner"
import type { ApiKeyView, CreatedApiKey } from "@/lib/api"
import { useApiKeys, useRevokeApiKey } from "@/lib/queries"
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MonoChip, StatusLed, type LedTone } from "@/components/settings/status-led"
import { SectionIcon } from "@/components/settings/status-overview"
import { ApiKeyCreateForm, ApiKeyReveal } from "@/components/settings/api-key-create"
import {
  apiErrorMessage,
  createdKeyLine,
  expiryShort,
  formatKeyDate,
  lastUsedShort,
  scopeLabel,
  usageTone,
  type UsageTone,
} from "@/components/settings/api-keys-logic"
import { useNarrowLayout } from "@/components/data/narrow-layout"

const USAGE_LED: Record<UsageTone, LedTone> = {
  live: "emerald",
  idle: "muted",
  stale: "amber",
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

function LastUsedCell({ apiKey, now }: { apiKey: ApiKeyView; now: number }) {
  const label = (
    <span className="inline-flex items-center gap-2">
      <StatusLed tone={USAGE_LED[usageTone(apiKey, now)]} />
      {lastUsedShort(apiKey, now)}
    </span>
  )
  if (!apiKey.lastUsedIp) return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {label}
          <span className="sr-only">, from {apiKey.lastUsedIp}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>From {apiKey.lastUsedIp}</TooltipContent>
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

/** Create, then the one-time reveal in the same dialog. */
export function CreateApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        // A stray click beside the reveal would throw the key away.
        onInteractOutside={(event) => created && event.preventDefault()}
        onCloseAutoFocus={() => setCreated(null)}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>{createdKeyLine(created.apiKey)}</DialogDescription>
            </DialogHeader>
            <ApiKeyReveal created={created} onDone={() => onOpenChange(false)} />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Name it after whatever will use it, so you know what breaks when you revoke it.
              </DialogDescription>
            </DialogHeader>
            <ApiKeyCreateForm onCreated={setCreated} onCancel={() => onOpenChange(false)} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function CreateApiKeyButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" onClick={onClick}>
      <Plus />
      Create key
    </Button>
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

export function ApiKeysOverview({ onCreate }: { onCreate: () => void }) {
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
        <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <SectionIcon icon={KeyRound} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">No keys yet</p>
            <p className="max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
              Create one key for each script, monitor or dashboard that reads GeoMetrikks. It sends the key in an{" "}
              <MonoChip>Authorization: Bearer</MonoChip> header, and you can revoke it here without touching the
              others.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={onCreate}>
            <Plus />
            Create key
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card ref={cardRef} tabIndex={-1} aria-label="API keys" className="gap-0 py-0 outline-none">
      <div ref={layoutRef}>
        <ApiKeysTable apiKeys={data.keys} narrow={narrow} onRevoked={() => cardRef.current?.focus()} />
      </div>
    </Card>
  )
}

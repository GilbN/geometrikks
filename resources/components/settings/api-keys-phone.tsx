/**
 * Settings > API keys on a card narrower than the table: one two-line row per
 * key, and a bottom drawer with the tapped key's details and its Revoke.
 */
import { useEffect, useId, useRef, useState } from "react"
import { ChevronRight, X } from "lucide-react"
import type { ApiKeyView } from "@/lib/api"
import { useRevokeApiKey } from "@/lib/queries"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { ApiKeyScopeBadge, UsageDot } from "@/components/settings/api-key-status"
import {
  apiErrorMessage,
  apiKeyAccessLine,
  apiKeyRowLine,
  apiKeyRowTone,
  expiryShort,
  formatKeyDate,
  isNotFoundError,
  lastUsedValue,
  revokeConfirmText,
  revokeVerb,
} from "@/components/settings/api-keys-logic"

const rowBadgeClasses = "h-[18px] px-1.5 text-[11px] font-normal"

/** Focuses the drawer's title rather than its first button, so it doesn't open with a ring on Close. */
export function focusDrawerTitle(event: Event) {
  event.preventDefault()
  const content = event.currentTarget
  if (content instanceof HTMLElement) content.querySelector<HTMLElement>("[data-slot='drawer-title']")?.focus()
}

export function ApiKeyList({
  apiKeys,
  now,
  onOpen,
}: {
  apiKeys: readonly ApiKeyView[]
  now: number
  onOpen: (keyId: string, opener: HTMLElement) => void
}) {
  return (
    <ul>
      {apiKeys.map((apiKey) => (
        <li key={apiKey.id} className="border-b last:border-b-0">
          <button
            type="button"
            data-api-key-row={apiKey.id}
            onClick={(event) => onOpen(apiKey.id, event.currentTarget)}
            className="flex min-h-[62px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="min-w-0 truncate text-[13.5px] font-medium">{apiKey.name}</span>
                <ApiKeyScopeBadge apiKey={apiKey} className={rowBadgeClasses} />
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <UsageDot tone={apiKeyRowTone(apiKey, now)} />
                <span className="min-w-0 truncate">{apiKeyRowLine(apiKey, now)}</span>
              </span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  )
}

export function ApiKeyDrawer({
  apiKey,
  open,
  onOpenChange,
  now,
  onRevoked,
  onCloseAutoFocus,
}: {
  apiKey: ApiKeyView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  now: number
  onRevoked: () => void
  onCloseAutoFocus: (event: Event) => void
}) {
  // The last key stays on screen while the drawer slides away.
  const shownRef = useRef<ApiKeyView | null>(null)
  if (apiKey) shownRef.current = apiKey
  const shown = apiKey ?? shownRef.current
  // A key revoked in another tab closes its drawer rather than leave stale details up.
  const gone = open && apiKey === null
  useEffect(() => {
    if (gone) onOpenChange(false)
  }, [gone, onOpenChange])
  // A swipe away mid-revoke would skip the focus handoff that runs once it lands.
  const [revoking, setRevoking] = useState(false)

  return (
    <Drawer open={open} onOpenChange={onOpenChange} dismissible={!revoking} autoFocus>
      <DrawerContent
        className="data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-92px)] md:mx-auto md:w-full md:max-w-lg"
        onOpenAutoFocus={focusDrawerTitle}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {shown && (
          <ApiKeyDetail
            key={shown.id}
            apiKey={shown}
            now={now}
            revoking={revoking}
            onRevokingChange={setRevoking}
            onRevoked={onRevoked}
          />
        )}
      </DrawerContent>
    </Drawer>
  )
}

function ApiKeyDetail({
  apiKey,
  now,
  revoking,
  onRevokingChange,
  onRevoked,
}: {
  apiKey: ApiKeyView
  now: number
  revoking: boolean
  onRevokingChange: (revoking: boolean) => void
  onRevoked: () => void
}) {
  return (
    <>
      <DrawerHeader className="flex-row items-start gap-2 pb-3 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
        <div className="min-w-0 flex-1 space-y-1">
          <DrawerTitle tabIndex={-1} className="flex items-center gap-2 text-[15px] outline-none">
            <span className="min-w-0 truncate">{apiKey.name}</span>
            <ApiKeyScopeBadge apiKey={apiKey} className={rowBadgeClasses} />
          </DrawerTitle>
          <DrawerDescription className="text-xs">{apiKeyAccessLine(apiKey)}</DrawerDescription>
        </div>
        {!revoking && (
          <DrawerClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Close" className="-mt-1 -mr-2 shrink-0">
              <X className="size-[18px]" />
            </Button>
          </DrawerClose>
        )}
      </DrawerHeader>
      <div className="space-y-4 overflow-y-auto overscroll-contain px-4 pb-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Key</dt>
          <dd className="font-mono text-xs leading-5">{apiKey.displayPrefix}…</dd>
          <dt className="text-muted-foreground">Last used</dt>
          <dd className="min-w-0 break-words">{lastUsedValue(apiKey, now)}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatKeyDate(apiKey.createdAt)}</dd>
          <dt className="text-muted-foreground">Expires</dt>
          <dd>{expiryShort(apiKey)}</dd>
        </dl>
        <RevokeInDrawer apiKey={apiKey} onRevokingChange={onRevokingChange} onRevoked={onRevoked} />
      </div>
    </>
  )
}

/** Revoke confirms in place. vaul bundles its own Radix Dialog, which keeps
 *  focus out of an AlertDialog opened from inside the drawer. */
function RevokeInDrawer({
  apiKey,
  onRevokingChange,
  onRevoked,
}: {
  apiKey: ApiKeyView
  onRevokingChange: (revoking: boolean) => void
  onRevoked: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const revokeApiKeyMutation = useRevokeApiKey()
  const pending = revokeApiKeyMutation.isPending
  const verb = revokeVerb(apiKey)
  useEffect(() => {
    onRevokingChange(pending)
    return () => onRevokingChange(false)
  }, [pending, onRevokingChange])
  const revokeRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  // Keep hands focus back to Revoke; otherwise the drawer's focus trap drops
  // it at the top of the drawer.
  const wasConfirming = useRef(false)
  useEffect(() => {
    if (wasConfirming.current && !confirming) revokeRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  const revoke = () => {
    if (pending) return
    setRevokeError(null)
    revokeApiKeyMutation.mutate(apiKey.id, {
      onSuccess: onRevoked,
      onError: (error) => {
        if (isNotFoundError(error)) {
          onRevoked()
          return
        }
        setRevokeError(apiErrorMessage(error, `Could not ${verb.toLowerCase()} ${apiKey.name}. Try again.`))
        requestAnimationFrame(() => keepRef.current?.focus())
      },
    })
  }

  if (!confirming) {
    return (
      <Button
        ref={revokeRef}
        type="button"
        variant="outline"
        size="lg"
        className="w-full border-destructive/45 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/45 dark:hover:bg-destructive/15"
        onClick={() => {
          setRevokeError(null)
          setConfirming(true)
        }}
      >
        {verb}
      </Button>
    )
  }

  // aria-disabled rather than disabled while the request runs, since a
  // disabled button drops focus out of the drawer to the page.
  return (
    <div
      role="group"
      aria-label={`${verb} ${apiKey.name}?`}
      aria-describedby={descriptionId}
      className="space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/[0.07] p-3 text-[12.5px] leading-relaxed"
    >
      <p id={descriptionId}>
        {verb} <span className="font-semibold">{apiKey.name}</span>? {revokeConfirmText(apiKey)}
      </p>
      {revokeError && (
        <p role="alert" className="text-destructive">
          {revokeError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          ref={keepRef}
          type="button"
          variant="outline"
          autoFocus
          aria-disabled={pending}
          className="flex-1 aria-disabled:opacity-50"
          onClick={() => {
            if (!pending) setConfirming(false)
          }}
        >
          Keep
        </Button>
        <Button
          type="button"
          variant="destructive"
          aria-disabled={pending}
          className="flex-1 aria-disabled:opacity-50"
          onClick={revoke}
        >
          {pending ? (apiKey.expired ? "Removing" : "Revoking") : verb}
        </Button>
      </div>
    </div>
  )
}

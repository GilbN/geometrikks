import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import {
  Check,
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  PlugZap,
  TriangleAlert,
  Unplug,
} from "lucide-react"
import { BrandMark } from "@/components/brand/brand-mark"
import { formatKeyDate, scopeLabel } from "@/components/settings/api-keys-logic"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { realChrome } from "../lib/chrome-api"
import { fetchConnection } from "../lib/client"
import { FEATURE_LABELS } from "../lib/connection"
import {
  clearRecent,
  getSettings,
  setSettings,
  type Settings,
  type StoredConnection,
} from "../lib/storage"
import {
  addressError,
  apiKeysPageUrl,
  connect,
  disconnect,
  grantAccess,
  loadDisplayed,
  UNEXPECTED_MESSAGE,
  type DisplayedConnection,
} from "./connect"

type FormErrors = { address: string | null; key: string | null; form: string | null }
const NO_ERRORS: FormErrors = { address: null, key: null, form: null }
const NOT_CONNECTED: DisplayedConnection = { stored: null, effective: null, hasAccess: true }

const KEY_PREFIX_LENGTH = 8
const KEY_MASK = "•".repeat(24)

/** What the user typed into the masked stored key, found by trimming the
 *  parts that still match the old value. */
function insertedText(before: string, after: string): string {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  return after.slice(start, after.length - end)
}

const reportUnexpected = (action: string, error: unknown) =>
  console.warn(`GeoMetrikks for Chrome: ${action} failed`, error)

const factsClass = "grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-[13px]"
const factTermClass = "text-muted-foreground"
const factValueClass = "m-0 flex flex-wrap items-center gap-1.5"

function hostOf(origin: string): string {
  return new URL(origin).host
}

const successText = "text-emerald-700 dark:text-emerald-400"

function KeyFacts({
  stored,
  effective,
}: {
  stored: StoredConnection
  effective: StoredConnection
}) {
  if (stored.keyless)
    return (
      <>
        <dt className={factTermClass}>Key</dt>
        <dd className={factValueClass}>
          {effective.connection.mode === "disabled"
            ? "Authentication is off on this server, so no key is needed"
            : "None. This server now asks for a key, so paste one and connect again"}
        </dd>
      </>
    )
  const verified = stored.connection.mode === "apiKey" ? stored.connection : null
  return (
    <>
      <dt className={factTermClass}>Key</dt>
      <dd className={factValueClass}>
        {verified?.name}
        {stored.verifiedScope && (
          <Badge variant="outline" className="text-muted-foreground">
            {scopeLabel(stored.verifiedScope)}
          </Badge>
        )}
      </dd>
      <dt className={factTermClass}>Expires</dt>
      <dd className={factValueClass}>
        {verified?.expiresAt ? formatKeyDate(verified.expiresAt) : "Never"}
      </dd>
    </>
  )
}

function ConnectedCard({
  stored,
  effective,
  busy,
  onDisconnect,
}: {
  stored: StoredConnection
  effective: StoredConnection
  busy: boolean
  onDisconnect: () => void
}) {
  const { connection } = effective
  const features = (Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[]).filter(
    (capability) => connection.capabilities.includes(capability),
  )
  return (
    <Card size="sm">
      <CardContent className="grid gap-3">
        <p role="status" className={cn("m-0 flex items-center gap-2 font-semibold", successText)}>
          <CircleCheck aria-hidden className="size-4" />
          Connected
        </p>
        <dl className={factsClass}>
          <KeyFacts stored={stored} effective={effective} />
          <dt className={factTermClass}>Server</dt>
          <dd className={factValueClass}>
            GeoMetrikks {connection.appVersion} · API {connection.apiVersion}
          </dd>
          <dt className={factTermClass}>Features</dt>
          <dd className={factValueClass}>
            {features.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              features.map((capability) => (
                <span
                  key={capability}
                  className={cn("inline-flex items-center gap-1", successText)}
                >
                  <Check aria-hidden className="size-3.5" />
                  {FEATURE_LABELS[capability]}
                </span>
              ))
            )}
          </dd>
        </dl>
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={onDisconnect}>
            <Unplug aria-hidden />
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function Options() {
  const ids = useId()
  const addressId = `${ids}-address`
  const keyId = `${ids}-key`
  const siteStatsId = `${ids}-site-stats`

  const [loaded, setLoaded] = useState(false)
  const [displayed, setDisplayed] = useState<DisplayedConnection>(NOT_CONNECTED)
  const [settings, setSettingsState] = useState<Settings>({ showSiteStats: true })
  const [address, setAddress] = useState("")
  /** Null while the field shows the stored key; the typed key once edited. */
  const [keyDraft, setKeyDraft] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS)
  const [busy, setBusy] = useState(false)
  const [recentCleared, setRecentCleared] = useState(false)
  const addressRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const addressEditedRef = useRef(false)
  const refreshes = useRef(0)

  const { stored, effective, hasAccess } = displayed
  const storedKey = stored?.key ?? null
  const showingStoredKey = keyDraft === null && storedKey !== null

  const refresh = useCallback(async () => {
    const run = ++refreshes.current
    const next = await loadDisplayed(realChrome)
    if (run !== refreshes.current) return
    setDisplayed(next)
    if (next.stored && !addressEditedRef.current) setAddress(next.stored.origin)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const [, savedSettings] = await Promise.all([refresh(), getSettings()])
        setSettingsState(savedSettings)
      } catch (error) {
        reportUnexpected("loading the settings", error)
        setErrors({ ...NO_ERRORS, form: UNEXPECTED_MESSAGE })
      } finally {
        setLoaded(true)
      }
    }
    void load()
  }, [refresh])

  useEffect(() => {
    const onStorageChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === "local" && ("connection" in changes || "connectionRefresh" in changes))
        void refresh()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const problem = addressError(address)
    if (problem) {
      setErrors({ ...NO_ERRORS, address: problem })
      addressRef.current?.focus()
      return
    }
    // connect() asks for the host permission before its first await, so it
    // has to start here, inside the gesture, with nothing awaited before it.
    const attempt = connect(
      { address, key: keyDraft ?? storedKey ?? "" },
      { chrome: realChrome, fetchConnection },
    )
    setBusy(true)
    setErrors(NO_ERRORS)
    const finish = async () => {
      try {
        const result = await attempt
        if (result.ok) {
          setDisplayed({ stored: result.stored, effective: result.stored, hasAccess: true })
          setAddress(result.stored.origin)
          addressEditedRef.current = false
          setKeyDraft(null)
          setShowKey(false)
          setRecentCleared(false)
          return
        }
        setErrors({ ...NO_ERRORS, [result.field ?? "form"]: result.message })
        if (result.field === "address") addressRef.current?.focus()
        if (result.field === "key") keyRef.current?.focus()
      } catch (error) {
        reportUnexpected("connecting", error)
        setErrors({ ...NO_ERRORS, form: UNEXPECTED_MESSAGE })
      } finally {
        setBusy(false)
      }
    }
    void finish()
  }

  const onDisconnect = async () => {
    setBusy(true)
    try {
      await disconnect({ chrome: realChrome })
      setDisplayed(NOT_CONNECTED)
      setKeyDraft(null)
      setShowKey(false)
      setErrors(NO_ERRORS)
    } catch (error) {
      reportUnexpected("disconnecting", error)
      setErrors({ ...NO_ERRORS, form: UNEXPECTED_MESSAGE })
      await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const onGrantAccess = () => {
    if (!stored || busy) return
    const request = grantAccess({ chrome: realChrome, stored })
    setBusy(true)
    const finish = async () => {
      try {
        await request
        await refresh()
      } catch (error) {
        reportUnexpected("granting access", error)
        setErrors({ ...NO_ERRORS, form: UNEXPECTED_MESSAGE })
      } finally {
        setBusy(false)
      }
    }
    void finish()
  }

  const onKeyChange = (value: string) => {
    if (errors.key) setErrors({ ...errors, key: null })
    if (!showingStoredKey) return setKeyDraft(value)
    if (showKey) return setKeyDraft(value)
    setKeyDraft(insertedText(maskedStoredKey, value))
  }

  const maskedStoredKey = storedKey ? `${storedKey.slice(0, KEY_PREFIX_LENGTH)}${KEY_MASK}` : ""

  const onOpenApiKeys = () => {
    const url = apiKeysPageUrl(address)
    if (!url) {
      setErrors({ ...errors, address: addressError(address) })
      addressRef.current?.focus()
      return
    }
    void realChrome.tabs.create({ url })
  }

  const onSiteStatsChange = async (checked: boolean) => {
    const next = { ...settings, showSiteStats: checked }
    setSettingsState(next)
    await setSettings(next)
  }

  const onClearRecent = async () => {
    await clearRecent()
    setRecentCleared(true)
  }

  return (
    <main className="mx-auto grid w-full max-w-[592px] gap-4 px-4 py-9">
      <h1 className="m-0 flex items-center gap-2.5 text-xl font-semibold">
        <BrandMark size={28} decorative />
        Connect GeoMetrikks
      </h1>
      <p className="m-0 text-[13.5px] text-muted-foreground">
        Make an API key in GeoMetrikks under Settings › API keys. A Read key gives you lookups and
        site stats. A Read/write key also lets you ban and unban.
      </p>

      {stored && !hasAccess && (
        <Card size="sm" className="ring-amber-500/40 bg-amber-500/[0.08]">
          <CardContent className="flex flex-wrap items-center gap-3">
            <p className="m-0 flex flex-1 items-center gap-2 text-amber-700 dark:text-amber-400">
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              GeoMetrikks for Chrome lost access to {hostOf(stored.origin)}.
            </p>
            <Button size="sm" disabled={busy} onClick={onGrantAccess}>
              Grant access
            </Button>
          </CardContent>
        </Card>
      )}

      <Card size="sm">
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-3.5" aria-busy={busy}>
            <Field className="gap-1.5" data-invalid={errors.address ? true : undefined}>
              <FieldLabel htmlFor={addressId} className="text-[13px]">
                Server address
              </FieldLabel>
              <Input
                ref={addressRef}
                id={addressId}
                name="address"
                type="url"
                inputMode="url"
                placeholder="https://geo.example.net"
                autoComplete="url"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="next"
                className="font-mono text-[13px] md:text-[13px]"
                value={address}
                aria-invalid={errors.address ? true : undefined}
                aria-describedby={`${addressId}-hint${errors.address ? ` ${addressId}-error` : ""}`}
                onChange={(event) => {
                  setAddress(event.target.value)
                  addressEditedRef.current = true
                  if (errors.address) setErrors({ ...errors, address: null })
                }}
                onBlur={() =>
                  setErrors((current) => ({ ...current, address: addressError(address) }))
                }
              />
              <FieldDescription id={`${addressId}-hint`} className="text-xs">
                The address you open GeoMetrikks on. Must start with <code>https://</code>. A LAN
                address like <code>https://geometrikks.lan</code> works too.
              </FieldDescription>
              {errors.address && (
                <FieldError id={`${addressId}-error`}>{errors.address}</FieldError>
              )}
            </Field>

            <Field className="gap-1.5" data-invalid={errors.key ? true : undefined}>
              <FieldLabel htmlFor={keyId} className="text-[13px]">
                API key
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  ref={keyRef}
                  id={keyId}
                  name="key"
                  type={showKey || showingStoredKey ? "text" : "password"}
                  placeholder="gmk_…"
                  autoComplete="off"
                  data-1p-ignore
                  data-bwignore
                  data-lpignore="true"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="go"
                  className="font-mono text-[13px] md:text-[13px]"
                  value={
                    showingStoredKey ? (showKey ? storedKey : maskedStoredKey) : (keyDraft ?? "")
                  }
                  aria-invalid={errors.key ? true : undefined}
                  aria-describedby={`${keyId}-hint${errors.key ? ` ${keyId}-error` : ""}`}
                  onChange={(event) => onKeyChange(event.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Show key"
                    aria-pressed={showKey}
                    onClick={() => setShowKey((shown) => !shown)}
                  >
                    {showKey ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription id={`${keyId}-hint`} className="text-xs">
                Stored on this computer only. It doesn't sync to your other browsers.
              </FieldDescription>
              {errors.key && <FieldError id={`${keyId}-error`}>{errors.key}</FieldError>}
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="submit"
                disabled={busy || !loaded}
                className="dark:border-transparent dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/80"
              >
                <PlugZap aria-hidden />
                {busy ? "Connecting…" : "Connect"}
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={onOpenApiKeys}>
                Open API keys in GeoMetrikks
                <ExternalLink aria-hidden />
              </Button>
            </div>
            {errors.form && <FieldError>{errors.form}</FieldError>}
          </form>
        </CardContent>
      </Card>

      {stored && effective && (
        <ConnectedCard
          stored={stored}
          effective={effective}
          busy={busy}
          onDisconnect={() => void onDisconnect()}
        />
      )}

      <Card size="sm">
        <CardContent className="grid gap-2.5">
          <h2 className="m-0 text-[11px] font-normal tracking-[0.06em] text-muted-foreground uppercase">
            Popup
          </h2>
          <div className={cn(factsClass, "grid-cols-[200px_1fr] items-center")}>
            <Label htmlFor={siteStatsId} className="font-normal text-muted-foreground">
              Show stats for the site I'm on
            </Label>
            <div className={factValueClass}>
              <Switch
                id={siteStatsId}
                checked={settings.showSiteStats}
                disabled={!loaded}
                onCheckedChange={(checked) => void onSiteStatsChange(checked)}
              />
            </div>
            <span className={factTermClass}>Address bar keyword</span>
            <span className={factValueClass}>
              <code>gmk</code>
              <span className="text-muted-foreground">(set by Chrome under Search engines)</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={() => void onClearRecent()}>
              Clear recent lookups
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {recentCleared ? "Recent lookups cleared." : ""}
            </span>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}

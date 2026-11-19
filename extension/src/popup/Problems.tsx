import type { ReactNode } from "react"
import {
  CircleArrowUp,
  ExternalLink,
  KeyRound,
  Plug,
  RotateCw,
  ShieldAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { realChrome } from "../lib/chrome-api"
import type { Failure } from "../lib/failures"
import { SITE_STATS_MIN_VERSION } from "../lib/version"

export type Problem = Failure | "not-connected"

const TONES = {
  error: { box: "border-destructive/45 bg-destructive/10", icon: "text-destructive" },
  warning: { box: "border-amber-500/45 bg-amber-500/10", icon: "text-amber-500" },
  neutral: { box: "bg-card", icon: "text-muted-foreground" },
}

function Notice({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "error" | "warning" | "neutral"
  icon: LucideIcon
  title: string
  children: ReactNode
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-[13px]", TONES[tone].box)}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONES[tone].icon)} />
      <div className="min-w-0">
        <p className="mb-0.5 font-semibold">{title}</p>
        {children}
      </div>
    </div>
  )
}

function Body({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return <p className={cn("text-[12.5px] text-muted-foreground", !last && "mb-2")}>{children}</p>
}

function OpenOptions({ label = "Open Options" }: { label?: string }) {
  return (
    <Button size="sm" onClick={() => void realChrome.runtime.openOptionsPage()}>
      {label}
    </Button>
  )
}

function ApiKeysLink({ origin }: { origin: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={`${origin}/settings/api-keys`} target="_blank" rel="noreferrer">
        API keys
        <ExternalLink />
      </a>
    </Button>
  )
}

function TryAgain({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <RotateCw />
      Try again
    </Button>
  )
}

/** Spec section 8: each failure with its one way out. */
export function Problems({
  problem,
  host,
  origin,
  keyName,
  onRetry,
}: {
  problem: Problem
  host: string | null
  origin: string | null
  keyName: string | null
  onRetry: () => void
}) {
  switch (problem) {
    case "not-connected":
      return (
        <Notice tone="neutral" icon={Plug} title="Connect GeoMetrikks">
          <Body>Add your GeoMetrikks server's address and an API key in Options.</Body>
          <OpenOptions />
        </Notice>
      )
    case "key-invalid":
      return (
        <Notice tone="error" icon={KeyRound} title="This key no longer works">
          <Body>
            {keyName ? `“${keyName}”` : "The key"} was revoked or has expired. Make a new key in
            GeoMetrikks and paste it in Options.
          </Body>
          <div className="flex gap-1.5">
            <OpenOptions />
            {origin && <ApiKeysLink origin={origin} />}
          </div>
        </Notice>
      )
    case "needs-key":
      return (
        <Notice tone="error" icon={KeyRound} title="This server now needs an API key">
          <Body>Make a key in GeoMetrikks and paste it in Options.</Body>
          <div className="flex gap-1.5">
            <OpenOptions />
            {origin && <ApiKeysLink origin={origin} />}
          </div>
        </Notice>
      )
    case "keys-unavailable":
      return (
        <Notice tone="error" icon={KeyRound} title="GeoMetrikks can't check keys right now">
          <Body>The server couldn't check API keys. Try again in a moment.</Body>
          <TryAgain onRetry={onRetry} />
        </Notice>
      )
    case "access-removed":
      return (
        <Notice
          tone="error"
          icon={ShieldAlert}
          title={`GeoMetrikks for Chrome lost access to ${host ?? "the server"}`}
        >
          <Body>
            Site access was removed in Chrome's extension settings. Grant it again in Options.
          </Body>
          <OpenOptions label="Grant access" />
        </Notice>
      )
    case "unreachable":
      return (
        <Notice tone="error" icon={WifiOff} title={`Can't reach ${host ?? "the server"}`}>
          <Body>
            The server didn't answer. If it's only on your home network, connect to it first.
          </Body>
          <TryAgain onRetry={onRetry} />
        </Notice>
      )
  }
}

export function SiteStatsNeedUpdate({
  appVersion,
  canWrite,
}: {
  appVersion: string
  canWrite: boolean
}) {
  const stillWorks = canWrite ? "Lookups and bans still work" : "Lookups still work"
  return (
    <Notice
      tone="warning"
      icon={CircleArrowUp}
      title={`Site stats need GeoMetrikks ${SITE_STATS_MIN_VERSION}`}
    >
      <Body last>
        This server runs {appVersion}. {stillWorks}; update the server for stats on your own sites.
      </Body>
    </Notice>
  )
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { apiV1AbuseipdbStatusGetAbuseipdbStatus } from "@/generated/api/sdk.gen"
import type { AbuseIpdbStatusResponse, DecisionView } from "@/generated/api/types.gen"
import { winningDecision } from "@/lib/crowdsec"
import { realChrome } from "../lib/chrome-api"
import { createExtensionClient, fetchConnection, unwrap } from "../lib/client"
import { deriveAccess } from "../lib/connection"
import { classifyFailure } from "../lib/failures"
import {
  getSettings,
  type PendingItem,
  type RecentLookup,
  type StoredConnection,
} from "../lib/storage"
import { Header, type ServerHealth } from "./Header"
import { Home } from "./Home"
import { Lookup } from "./Lookup"
import { loadDropIndex } from "./marks"
import {
  connectionChanged,
  readOpenContext,
  readStoredConnection,
  refreshViaWorker,
  type OpenContext,
  type PopupSession,
} from "./open-context"
import { Problems, type Problem } from "./Problems"
import { chooseHome, type HomeMode } from "./site-stats"

interface Opened {
  ctx: OpenContext
  stored: StoredConnection | null
  claimed: PendingItem | null
}

type Check =
  | { kind: "checking" }
  | { kind: "problem"; problem: Problem }
  | { kind: "ready"; session: PopupSession; home: "pending" | HomeMode }

async function fetchAbuseStatus(
  client: PopupSession["client"],
): Promise<AbuseIpdbStatusResponse | null> {
  try {
    const result = unwrap<AbuseIpdbStatusResponse>(
      await apiV1AbuseipdbStatusGetAbuseipdbStatus({ client }),
    )
    return result.ok ? result.data : null
  } catch {
    return null
  }
}

async function checkConnection(opened: Opened & { stored: StoredConnection }): Promise<Check> {
  const { ctx, stored, claimed } = opened
  const permitted = await realChrome.permissions.contains({ origins: [stored.pattern] })
  if (!permitted) return { kind: "problem", problem: "access-removed" }
  const target = { origin: stored.origin, key: stored.key }
  const [result, settings] = await Promise.all([fetchConnection(target), getSettings()])
  if (!result.ok) {
    const problem = classifyFailure(result.failure, {
      keyless: stored.keyless,
      permissionMissing: false,
    })
    return { kind: "problem", problem }
  }
  const fresh = result.connection
  const access = deriveAccess(stored, fresh)
  if (connectionChanged(stored.connection, fresh)) {
    void refreshViaWorker(fresh, { origin: stored.origin, savedAt: stored.savedAt })
  }
  const client = createExtensionClient(target)
  const session: PopupSession = {
    ctx,
    stored: { ...stored, connection: fresh },
    connection: fresh,
    client,
    access,
    settings,
    abuseStatus: fetchAbuseStatus(client),
    dropIndex: loadDropIndex(client, realChrome, access, {
      origin: stored.origin,
      savedAt: stored.savedAt,
    }),
  }
  const home = chooseHome({
    claimed,
    pendingPage: ctx.pendingId !== null,
    access,
    settings,
    tabUrl: ctx.tabUrl,
  })
  return { kind: "ready", session, home }
}

/** Reads the open context and connection, then claims a right-click result.
 *  Any failure still opens the popup, with nothing claimed. */
async function openPopup(
  claim: (ctx: OpenContext, origin: string) => Promise<PendingItem | null>,
): Promise<Opened> {
  let ctx: OpenContext
  try {
    ctx = await readOpenContext()
  } catch {
    const pendingId = new URLSearchParams(location.search).get("pending")
    ctx = { windowId: -1, tabUrl: undefined, pendingId }
  }
  let stored: StoredConnection | null = null
  try {
    stored = await readStoredConnection()
  } catch {
    stored = null
  }
  let claimed: PendingItem | null = null
  try {
    if (stored) claimed = await claim(ctx, stored.origin)
  } catch {
    claimed = null
  }
  return { ctx, stored, claimed }
}

function hostOf(origin: string): string {
  return new URL(origin).host
}

/** What a right-click result renders with. While the check runs, or after
 *  it failed, there is no session and only a summary can show. */
export interface PendingView {
  session: PopupSession | null
  lookup: (ip: string) => ReactNode
  home: (initialSearch: string) => ReactNode
}

const claimNothing = async (): Promise<PendingItem | null> => null
const renderNothing = (): ReactNode => null

export function Popup({
  claim = claimNothing,
  renderPending = renderNothing,
}: {
  /** Must keep its identity across renders: a new function claims again. */
  claim?: (ctx: OpenContext, origin: string) => Promise<PendingItem | null>
  renderPending?: (item: PendingItem, view: PendingView) => ReactNode
}) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [checked, setCheck] = useState<Check>({ kind: "checking" })
  const [attempt, setAttempt] = useState(0)
  const [lookupIp, setLookupIp] = useState<string | null>(null)
  const [lookups, setLookups] = useState(0)
  const [recent, setRecent] = useState<RecentLookup[] | null>(null)
  const [decisionTypes, setDecisionTypes] = useState<Record<string, string | null>>({})
  const [pendingDismissed, setPendingDismissed] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const returning = useRef(false)

  // A claim removes the item, so it runs once per open, before any host
  // query. The ref keeps StrictMode's second mount from claiming again.
  const opening = useRef<{ claim: typeof claim; promise: Promise<Opened> } | null>(null)
  useEffect(() => {
    if (opening.current?.claim !== claim) opening.current = { claim, promise: openPopup(claim) }
    const { promise } = opening.current
    let cancelled = false
    void (async () => {
      const next = await promise
      if (!cancelled) setOpened(next)
    })()
    return () => {
      cancelled = true
    }
  }, [claim])

  useEffect(() => {
    if (opened === null) return
    const { stored } = opened
    if (stored === null) return
    let cancelled = false
    void (async () => {
      let next: Check
      try {
        next = await checkConnection({ ...opened, stored })
      } catch {
        next = { kind: "problem", problem: "unreachable" }
      }
      if (!cancelled) setCheck(next)
    })()
    return () => {
      cancelled = true
    }
  }, [opened, attempt])

  const stored = opened?.stored ?? null
  const claimed = pendingDismissed ? null : (opened?.claimed ?? null)
  const check: Check =
    opened !== null && stored === null ? { kind: "problem", problem: "not-connected" } : checked
  const host = stored ? hostOf(stored.origin) : null
  const health: ServerHealth =
    check.kind === "ready" ? "ok" : check.kind === "problem" ? "bad" : "checking"
  const readOnly = check.kind === "ready" && !check.session.access.write
  const retry = () => {
    setCheck({ kind: "checking" })
    setAttempt((value) => value + 1)
  }
  const onLookup = (ip: string) => {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    setLookupIp(ip)
    setLookups((count) => count + 1)
    setPendingDismissed(true)
  }
  const onBack = () => {
    returning.current = true
    setLookupIp(null)
    setPendingDismissed(true)
  }
  const onDecisions = useCallback((ip: string, decisions: DecisionView[]) => {
    const type = winningDecision(decisions)?.type ?? null
    setDecisionTypes((previous) => ({ ...previous, [ip]: type }))
  }, [])

  useEffect(() => {
    if (lookupIp !== null || !returning.current) return
    returning.current = false
    const target = opener.current?.isConnected ? opener.current : searchRef.current
    target?.focus()
  }, [lookupIp, pendingDismissed])
  // After leaving a right-click result, Home shows recent lookups. A
  // menu-opened popup never queries the tab's host.
  const ready =
    check.kind === "ready" && claimed === null
      ? { session: check.session, home: check.home === "pending" ? "recent" : check.home }
      : null
  const lookup = ready && lookupIp !== null ? lookupIp : null
  const session = check.kind === "ready" ? check.session : null
  const pendingLookup = claimed !== null && claimed.ip !== null && session !== null

  const problem =
    check.kind === "problem" ? (
      <Problems
        problem={check.problem}
        host={host}
        origin={stored?.origin ?? null}
        keyName={stored?.connection.mode === "apiKey" ? stored.connection.name : null}
        onRetry={retry}
      />
    ) : null

  return (
    <div className="flex max-h-[600px] flex-col bg-background text-[13px] text-foreground">
      <Header
        host={host}
        health={health}
        readOnly={readOnly}
        {...(lookup !== null || pendingLookup ? { title: "Lookup", onBack } : {})}
      />
      {claimed !== null && session !== null ? (
        renderPending(claimed, {
          session,
          lookup: (ip) => (
            <Lookup session={session} ip={ip} onDecisions={onDecisions} onRecent={setRecent} />
          ),
          home: (initialSearch) => (
            <Home
              session={session}
              mode="recent"
              onLookup={onLookup}
              searchRef={searchRef}
              recent={recent}
              decisionTypes={decisionTypes}
              initialSearch={initialSearch}
            />
          ),
        })
      ) : claimed !== null ? (
        <main className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-auto p-3">
          {problem}
          {renderPending(claimed, { session: null, lookup: () => null, home: () => null })}
        </main>
      ) : ready ? (
        <>
          {lookup !== null && (
            <Lookup
              key={`${lookups}:${lookup}`}
              session={ready.session}
              ip={lookup}
              onDecisions={onDecisions}
              onRecent={setRecent}
            />
          )}
          {/* Hidden, not unmounted, so Back doesn't load the site stats again. */}
          <div className={lookup !== null ? "hidden" : "contents"}>
            <Home
              session={ready.session}
              mode={ready.home}
              onLookup={onLookup}
              searchRef={searchRef}
              recent={recent}
              decisionTypes={decisionTypes}
            />
          </div>
        </>
      ) : problem ? (
        <main className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3">{problem}</main>
      ) : (
        <main className="min-h-24" aria-busy="true" />
      )}
    </div>
  )
}

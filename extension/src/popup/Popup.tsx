import { useEffect, useState, type ReactNode } from "react"
import { apiV1AbuseipdbStatusGetAbuseipdbStatus } from "@/generated/api/sdk.gen"
import type { AbuseIpdbStatusResponse } from "@/generated/api/types.gen"
import { realChrome } from "../lib/chrome-api"
import { createExtensionClient, fetchConnection, unwrap } from "../lib/client"
import { deriveAccess, effectiveConnection } from "../lib/connection"
import { classifyFailure } from "../lib/failures"
import {
  getConnection,
  getConnectionRefresh,
  getSettings,
  type PendingItem,
  type StoredConnection,
} from "../lib/storage"
import { Header, type ServerHealth } from "./Header"
import { Home } from "./Home"
import { Lookup } from "./Lookup"
import { loadDropIndex } from "./marks"
import {
  connectionChanged,
  readOpenContext,
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
  const target = { origin: stored.origin, key: stored.key }
  const [permitted, result, settings] = await Promise.all([
    realChrome.permissions.contains({ origins: [stored.pattern] }),
    fetchConnection(target),
    getSettings(),
  ])
  if (!permitted) return { kind: "problem", problem: "access-removed" }
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
  const [abuseStatus, dropIndex] = await Promise.all([
    fetchAbuseStatus(client),
    loadDropIndex(client, realChrome, access, { origin: stored.origin, savedAt: stored.savedAt }),
  ])
  const session: PopupSession = {
    ctx,
    stored: { ...stored, connection: fresh },
    connection: fresh,
    client,
    access,
    settings,
    abuseStatus,
    dropIndex,
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

function hostOf(origin: string): string {
  return new URL(origin).host
}

const claimNothing = async (): Promise<PendingItem | null> => null
const renderNothing = (): ReactNode => null

export function Popup({
  claim = claimNothing,
  renderPending = renderNothing,
}: {
  /** Must keep its identity across renders: a new function claims again. */
  claim?: (ctx: OpenContext, origin: string) => Promise<PendingItem | null>
  renderPending?: (item: PendingItem) => ReactNode
}) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [checked, setCheck] = useState<Check>({ kind: "checking" })
  const [attempt, setAttempt] = useState(0)
  const [lookupIp, setLookupIp] = useState<string | null>(null)
  const [lookups, setLookups] = useState(0)

  // A claim removes the item, so it runs once per open, before any host query.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ctx = await readOpenContext()
      const saved = await getConnection()
      const stored = saved && effectiveConnection(saved, await getConnectionRefresh())
      const claimed = stored ? await claim(ctx, stored.origin) : null
      if (!cancelled) setOpened({ ctx, stored, claimed })
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
  const claimed = opened?.claimed ?? null
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
    setLookupIp(ip)
    setLookups((count) => count + 1)
  }
  const onBack = () => {
    setLookupIp(null)
    setLookups((count) => count + 1)
  }
  const ready =
    check.kind === "ready" && check.home !== "pending"
      ? { session: check.session, home: check.home }
      : null
  const lookup = ready && lookupIp !== null ? lookupIp : null

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
        {...(lookup !== null ? { title: "Lookup", onBack } : {})}
      />
      {claimed !== null ? (
        <main className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-auto p-3">
          {problem}
          {renderPending(claimed)}
        </main>
      ) : ready ? (
        <>
          {lookup !== null && (
            <Lookup key={`${lookups}:${lookup}`} session={ready.session} ip={lookup} />
          )}
          {/* Hidden, not unmounted, so Back doesn't load the site stats again. */}
          <div className={lookup !== null ? "hidden" : "contents"}>
            <Home
              session={ready.session}
              mode={ready.home}
              onLookup={onLookup}
              recentVersion={lookups}
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

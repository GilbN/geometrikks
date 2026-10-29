/**
 * Bans and unbans wait 5 seconds before they reach CrowdSec, behind a toast
 * with Undo. Undo is exact because the LAPI never saw the request: deleting
 * a ban afterwards would need its new decision id, and putting back what an
 * unban removed would mint new decisions under this app's origin.
 *
 * One store serves every ban and unban control, so a row, a menu and a map
 * popup for the same IP all show the same state, and each of them offers
 * Undo while the action waits. The toast's Undo is a shortcut, not the only
 * way back: a sheet's focus trap keeps the keyboard out of the toast.
 *
 * A waiting action goes out at once when the page unloads, and on a phone
 * when the page is hidden, because a phone may freeze a hidden page before
 * its timers fire. A desktop keeps timers running in a background tab, so
 * switching tabs there leaves the Undo window alone. Those early requests
 * use keepalive, so the browser finishes them after the page is gone.
 */
import { useCallback, useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { banIp, unbanIp, type DecisionView } from "@/lib/api"
import { crowdsecErrorMessage } from "@/lib/crowdsec"

export const UNDO_WINDOW_MS = 5000
/** The lookup query's staleTime: an unban counts decisions only from an answer this fresh. */
const LOOKUP_FRESH_MS = 30_000

export type PendingIpAction =
  | { kind: "ban"; ip: string; duration: string; durationLabel: string }
  | { kind: "unban"; ip: string }

/** An action and whether its request is already on its way. */
export interface PendingIpState {
  action: PendingIpAction
  /** Sent and not answered yet: too late to undo. */
  sending: boolean
}

interface Entry extends PendingIpState {
  timer: number
  /** Unique per scheduled action: a toast still animating out after an Undo
   *  would take a new toast with the same id along with it. */
  toastId: string
  /** The request once sent, so a flush can wait for it too. */
  request?: Promise<void>
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<string, PendingIpState> = new Map()
let queryClient: QueryClient | null = null
let flushBound = false

function publish() {
  snapshot = new Map([...entries].map(([ip, { action, sending }]) => [ip, { action, sending }]))
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let toastSerial = 0

/** Drops a waiting action. Does nothing once its request is on its way. */
export function undoIpAction(ip: string) {
  const entry = entries.get(ip)
  if (!entry || entry.sending) return
  window.clearTimeout(entry.timer)
  entries.delete(ip)
  publish()
  toast.dismiss(entry.toastId)
}

/** "for 4 hours", or "for good" rather than "for Forever". */
function forDuration(durationLabel: string): string {
  return durationLabel === "Forever" ? "for good" : `for ${durationLabel}`
}

function title(action: PendingIpAction): string {
  return action.kind === "ban" ? `Banning ${action.ip} ${forDuration(action.durationLabel)}` : `Unbanning ${action.ip}`
}

function done(action: PendingIpAction): string {
  return action.kind === "ban" ? `Banned ${action.ip} ${forDuration(action.durationLabel)}` : `Unbanned ${action.ip}`
}

function failure(action: PendingIpAction, error: unknown) {
  const verb = action.kind === "ban" ? "Ban" : "Unban"
  const fallback = `${verb} failed for ${action.ip}; the LAPI may be unreachable.`
  toast.error(error instanceof KeepaliveError ? (error.detail ?? fallback) : crowdsecErrorMessage(error, fallback))
}

/** Clears the entry once fresh CrowdSec data is in, so the controls never
 *  show the state from before the request in between. */
async function settle(ip: string) {
  try {
    await queryClient?.invalidateQueries({ queryKey: ["crowdsec"] })
    // Another action settling meanwhile cancels and restarts this refetch,
    // so wait until no CrowdSec query is still fetching, within reason.
    const deadline = Date.now() + 10_000
    while (queryClient && queryClient.isFetching({ queryKey: ["crowdsec"] }) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
  } finally {
    entries.delete(ip)
    publish()
  }
}

/** The backend's detail from a failed keepalive request, read the way
 *  crowdsecErrorMessage reads an axios error. */
class KeepaliveError extends Error {
  constructor(readonly status: number, readonly detail: string | null) {
    super(detail ?? `HTTP ${status}`)
  }
}

async function keepaliveRequest(action: PendingIpAction): Promise<void> {
  const [path, body] = action.kind === "ban"
    ? ["/api/v1/crowdsec/ban", { ip: action.ip, duration: action.duration }]
    : ["/api/v1/crowdsec/unban", { ip: action.ip }]
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    keepalive: true,
  })
  if (response.ok) return
  // Same rule as the axios client: an expired session goes to the login page.
  if (response.status === 401 && window.location.pathname !== "/login") window.location.href = "/login"
  const answer = (await response.json().catch(() => null)) as { detail?: string } | null
  throw new KeepaliveError(response.status, answer?.detail ?? null)
}

/** Sends a waiting action now. `keepalive` lets the request outlive the page. */
function send(ip: string, keepalive: boolean): Promise<void> {
  const entry = entries.get(ip)
  if (!entry) return Promise.resolve()
  if (entry.sending) return entry.request ?? Promise.resolve()
  window.clearTimeout(entry.timer)
  entry.sending = true
  publish()
  toast.dismiss(entry.toastId)
  const { action } = entry
  const request = keepalive
    ? keepaliveRequest(action)
    : action.kind === "ban"
      ? banIp({ ip, duration: action.duration })
      : unbanIp(ip)
  entry.request = request.then(
    () => {
      toast.success(done(action))
      return settle(ip)
    },
    (error: unknown) => {
      failure(action, error)
      return settle(ip)
    },
  )
  return entry.request
}

/** Sends every waiting action now and resolves once each, and any already
 *  on its way, has settled. Log out awaits it, so no request is left
 *  behind a session that is about to end. */
export function flushIpActions(): Promise<unknown> {
  return Promise.all([...entries.keys()].map((ip) => send(ip, false)))
}

function flushAll() {
  for (const ip of [...entries.keys()]) void send(ip, true)
}

function bindFlush() {
  if (flushBound) return
  flushBound = true
  window.addEventListener("pagehide", flushAll)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && window.matchMedia("(pointer: coarse)").matches) flushAll()
  })
}

/** What an unban removes, from the decisions this page looked up last for
 *  the IP. Unban deletes the IP's own decisions from every origin; a range
 *  decision that covers it stays, so ranges are left out of the count. */
function unbanSummary(ip: string): string {
  if (ip.includes("/")) return "Removes every decision on this range, from every origin."
  const queries = queryClient?.getQueryCache().findAll({ queryKey: ["crowdsec", "lookup", ip] }) ?? []
  // Only a fresh answer: an old or invalidated one can count decisions
  // that CAPI or another bouncer has since added or removed.
  const newest = queries
    .filter(
      (query) =>
        query.state.data !== undefined &&
        !query.state.isInvalidated &&
        Date.now() - query.state.dataUpdatedAt < LOOKUP_FRESH_MS,
    )
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]
  const decisions = newest?.state.data as DecisionView[] | undefined
  return describeUnban(decisions?.filter((decision) => decision.scope === "Ip"))
}

export function describeUnban(decisions: readonly Pick<DecisionView, "origin">[] | undefined): string {
  if (!decisions || decisions.length === 0) return "Removes every decision on this IP, from every origin."
  const total = decisions.length
  const crowd = decisions.filter((decision) => decision.origin === "CAPI" || decision.origin === "lists").length
  const count = total === 1 ? "1 decision" : `${total} decisions`
  if (crowd === 0) return `Removes ${count}.`
  if (crowd === total) return `Removes ${count} from the crowd.`
  return `Removes ${count}, ${crowd} of them from the crowd.`
}

/** The action waiting or on its way for one IP, or null. */
export function usePendingIpAction(ip: string): PendingIpState | null {
  const all = useSyncExternalStore(subscribe, () => snapshot)
  return all.get(ip) ?? null
}

/** Ban and unban through the undo window. */
export function useIpActions() {
  const client = useQueryClient()

  const schedule = useCallback(
    (action: PendingIpAction) => {
      queryClient = client
      bindFlush()
      if (entries.get(action.ip)?.sending) {
        toast(`${action.kind === "ban" ? "A ban" : "An unban"} for ${action.ip} is already on its way.`)
        return
      }
      // A second action on the same IP replaces the first; neither was sent.
      undoIpAction(action.ip)

      const id = `ip-action:${action.ip}:${++toastSerial}`
      const seconds = Math.round(UNDO_WINDOW_MS / 1000)
      const summary = action.kind === "unban" ? `${unbanSummary(action.ip)} ` : ""
      toast(title(action), {
        id,
        description: `${summary}Sent to CrowdSec in ${seconds} seconds.`,
        // The store's timer decides when the request goes, not the toast's,
        // which pauses while hovered. Without a close button or a swipe,
        // the toast only goes away by Undo or by sending.
        duration: Number.POSITIVE_INFINITY,
        dismissible: false,
        closeButton: false,
        action: { label: "Undo", onClick: () => undoIpAction(action.ip) },
      })
      const timer = window.setTimeout(() => send(action.ip, false), UNDO_WINDOW_MS)
      entries.set(action.ip, { action, sending: false, timer, toastId: id })
      publish()
    },
    [client],
  )

  return {
    ban: (ip: string, duration: string, durationLabel: string) =>
      schedule({ kind: "ban", ip, duration, durationLabel }),
    unban: (ip: string) => schedule({ kind: "unban", ip }),
  }
}

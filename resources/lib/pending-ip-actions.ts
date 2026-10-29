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
 * A waiting action goes out at once when the page is hidden or unloaded,
 * because a hidden page's timers may never fire again. Those requests use
 * keepalive, so the browser finishes them after the page is gone.
 */
import { useCallback, useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { banIp, unbanIp, type DecisionView } from "@/lib/api"
import { crowdsecErrorMessage } from "@/lib/crowdsec"

export const UNDO_WINDOW_MS = 5000

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

const toastId = (ip: string) => `ip-action:${ip}`

/** Drops a waiting action. Does nothing once its request is on its way. */
export function undoIpAction(ip: string) {
  const entry = entries.get(ip)
  if (!entry || entry.sending) return
  window.clearTimeout(entry.timer)
  entries.delete(ip)
  publish()
  toast.dismiss(toastId(ip))
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
  toast.error(crowdsecErrorMessage(error, `${verb} failed for ${action.ip}; the LAPI may be unreachable.`))
}

function settle(ip: string) {
  entries.delete(ip)
  publish()
  void queryClient?.invalidateQueries({ queryKey: ["crowdsec"] })
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

/** Sends a waiting action now. `keepalive` lets the request outlive the page. */
function send(ip: string, keepalive: boolean) {
  const entry = entries.get(ip)
  if (!entry || entry.sending) return
  window.clearTimeout(entry.timer)
  entry.sending = true
  publish()
  toast.dismiss(toastId(ip))
  const { action } = entry
  const request = keepalive
    ? keepaliveRequest(action)
    : action.kind === "ban"
      ? banIp({ ip, duration: action.duration })
      : unbanIp(ip)
  request.then(
    () => {
      settle(ip)
      toast.success(done(action))
    },
    (error: unknown) => {
      settle(ip)
      failure(action, error)
    },
  )
}

function flushAll() {
  for (const ip of [...entries.keys()]) send(ip, true)
}

function bindFlush() {
  if (flushBound) return
  flushBound = true
  window.addEventListener("pagehide", flushAll)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll()
  })
}

/** What an unban removes, from the decisions this page looked up last for
 *  the IP. Unban deletes the IP's own decisions from every origin; a range
 *  decision that covers it stays, so ranges are left out of the count. */
function unbanSummary(ip: string): string {
  if (ip.includes("/")) return "Removes every decision on this range, from every origin."
  const queries = queryClient?.getQueryCache().findAll({ queryKey: ["crowdsec", "lookup", ip] }) ?? []
  const newest = queries
    .filter((query) => query.state.data !== undefined)
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
      if (entries.get(action.ip)?.sending) return
      // A second action on the same IP replaces the first; neither was sent.
      undoIpAction(action.ip)

      const seconds = Math.round(UNDO_WINDOW_MS / 1000)
      const summary = action.kind === "unban" ? `${unbanSummary(action.ip)} ` : ""
      toast(title(action), {
        id: toastId(action.ip),
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
      entries.set(action.ip, { action, sending: false, timer })
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

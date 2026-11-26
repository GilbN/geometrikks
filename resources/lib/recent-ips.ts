/**
 * The last IPs opened in the inspector, newest first, which the command
 * palette lists before anything is typed. Kept in this browser only.
 */
import { useSyncExternalStore } from "react"
import { isValidIp } from "@/lib/crowdsec"

export const RECENT_IPS_KEY = "geometrikks-recent-ips"
const MAX_RECENT = 5

const listeners = new Set<() => void>()
let cache: { raw: string | null; ips: string[] } = { raw: null, ips: [] }

function read(): string[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(RECENT_IPS_KEY)
  } catch {
    return cache.ips
  }
  if (raw === cache.raw) return cache.ips
  let ips: string[] = []
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      ips = parsed
        .filter((entry): entry is string => typeof entry === "string" && isValidIp(entry))
        .slice(0, MAX_RECENT)
    }
  } catch {
    ips = []
  }
  cache = { raw, ips }
  return ips
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === RECENT_IPS_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function rememberInspectedIp(ip: string): void {
  const next = [ip, ...read().filter((entry) => entry !== ip)].slice(0, MAX_RECENT)
  const raw = JSON.stringify(next)
  try {
    localStorage.setItem(RECENT_IPS_KEY, raw)
  } catch {
    // Storage may be blocked. The list then lasts this session only.
  }
  cache = { raw, ips: next }
  for (const listener of listeners) listener()
}

export function useRecentIps(): string[] {
  return useSyncExternalStore(subscribe, read, () => [])
}

import { useSyncExternalStore } from "react"
import type { MutedIpView } from "@/generated/api/types.gen"
import { canonicalIp } from "@/lib/abuseipdb"

const HIDDEN_STORAGE_KEY = "mutedIpsHidden"
const VERSION_STORAGE_KEY = "mutedIpsVersion"
const EMPTY_VERSION = "empty"
const UNKNOWN_PREFIX = "unknown-"

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** "empty" for no entries, else an 8 hex character FNV-1a hash of the sorted networks. */
export function listVersion(networks: string[]): string {
  if (networks.length === 0) return EMPTY_VERSION
  const joined = [...networks].sort().join(",")
  let hash = FNV_OFFSET_BASIS
  for (const byte of new TextEncoder().encode(joined)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export type MutedChip = "none" | "shown" | "greyed" | "hiding"

export type MutedScope = {
  flag: boolean
  version: string
  count: number | null
  chip: MutedChip
}

/** Outside a page's provider, such as Overview's hooks: the flag stays off. */
export const DEFAULT_MUTED_SCOPE: MutedScope = {
  flag: false,
  version: EMPTY_VERSION,
  count: null,
  chip: "none",
}

export function mutedScope(args: {
  switchOn: boolean
  version: string
  count: number | null
  hasIpInclude: boolean
}): MutedScope {
  const { switchOn, version, count, hasIpInclude } = args
  const flag = switchOn && version !== EMPTY_VERSION && !hasIpInclude
  let chip: MutedChip
  if (version === EMPTY_VERSION) chip = "none"
  else if (!switchOn) chip = "shown"
  else if (hasIpInclude) chip = "greyed"
  else chip = "hiding"
  return { flag, version, count, chip }
}

export function retentionNoteFor(args: {
  flag: boolean
  rangeStart: Date
  now: Date
  rawRetentionDays: number
}): boolean {
  const { flag, rangeStart, now, rawRetentionDays } = args
  return flag && rangeStart.getTime() < now.getTime() - rawRetentionDays * 86_400_000
}

/** The phone Filters badge counts the switch; "Clear filters" cannot clear it, so it does not. */
export function mutedDrawerCounts(
  urlCount: number,
  flag: boolean,
): { activeCount: number; clearCount: number } {
  return { activeCount: urlCount + (flag ? 1 : 0), clearCount: urlCount }
}

export type VersionStoreState = {
  /** A local write happened and no GET that started after it has succeeded. */
  unconfirmed: boolean
  /** Version and size of the last list a GET returned, or null before any. */
  confirmed: { version: string; count: number } | null
  /** A GET attempt has settled, by success or error. */
  attempted: boolean
  /** The version from the last successful GET in this browser. */
  stored: string | null
  /** The n of the current "unknown-<n>". */
  unknownCounter: number
  /** The one write's unknown version and the confirmed version a post-write GET produced for it. */
  confirmedFromWrite: { from: string; to: string } | null
}

export function resolveVersion(store: VersionStoreState): string {
  if (store.unconfirmed) return `${UNKNOWN_PREFIX}${store.unknownCounter}`
  if (store.confirmed) return store.confirmed.version
  if (!store.attempted && store.stored !== null) return store.stored
  return `${UNKNOWN_PREFIX}${store.unknownCounter}`
}

function readStoredVersion(): string | null {
  try {
    return localStorage.getItem(VERSION_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredVersion(version: string | null): void {
  try {
    if (version === null) localStorage.removeItem(VERSION_STORAGE_KEY)
    else localStorage.setItem(VERSION_STORAGE_KEY, version)
  } catch {
    // Storage may be blocked; the in-memory state still holds for this session.
  }
}

let store: VersionStoreState | null = null
let snapshot: { version: string; count: number | null } | null = null
let writeSequence = 0
const versionListeners = new Set<() => void>()

export function getVersionStore(): VersionStoreState {
  if (store === null) {
    store = {
      unconfirmed: false,
      confirmed: null,
      attempted: false,
      stored: readStoredVersion(),
      unknownCounter: 0,
      confirmedFromWrite: null,
    }
  }
  return store
}

function updateStore(next: Partial<VersionStoreState>): void {
  store = { ...getVersionStore(), ...next }
  snapshot = null
  versionListeners.forEach((listener) => listener())
}

export function subscribeVersionStore(listener: () => void): () => void {
  versionListeners.add(listener)
  return () => versionListeners.delete(listener)
}

/** The write counter a GET should capture when it starts, for `noteListLoaded`. */
export function currentWriteSequence(): number {
  return writeSequence
}

/**
 * `startedAtWrite` is the write counter when the GET began. A GET that began
 * before a write can still resolve after it, with the list as it was before,
 * so its answer is dropped instead of confirming the write.
 */
export function noteListLoaded(networks: string[], startedAtWrite: number = writeSequence): void {
  if (startedAtWrite !== writeSequence) return
  const version = listVersion(networks)
  const previous = getVersionStore()
  if (
    !previous.unconfirmed &&
    previous.confirmed?.version === version &&
    previous.confirmed.count === networks.length
  ) {
    return
  }
  writeStoredVersion(version)
  updateStore({
    confirmedFromWrite: previous.unconfirmed
      ? { from: resolveVersion(previous), to: version }
      : null,
    unconfirmed: false,
    confirmed: { version, count: networks.length },
    attempted: true,
    stored: version,
  })
}

export function noteFirstLoadFailed(): void {
  const current = getVersionStore()
  // Retries, polls and background errors keep the same unknown version: a new one re-keys every flagged query.
  if (current.confirmed || current.unconfirmed || current.attempted) return
  updateStore({ attempted: true, unknownCounter: current.unknownCounter + 1 })
}

export function markUnconfirmed(): void {
  writeSequence += 1
  writeStoredVersion(null)
  updateStore({
    unconfirmed: true,
    stored: null,
    confirmedFromWrite: null,
    unknownCounter: getVersionStore().unknownCounter + 1,
  })
}

export function resetMutedIpsStoreForTests(): void {
  store = null
  snapshot = null
  writeSequence = 0
  versionListeners.clear()
  hiddenCurrent = null
  hiddenListeners.clear()
}

function readVersionSnapshot(): { version: string; count: number | null } {
  if (snapshot === null) {
    const current = getVersionStore()
    snapshot = {
      version: resolveVersion(current),
      count: !current.unconfirmed && current.confirmed ? current.confirmed.count : null,
    }
  }
  return snapshot
}

export function useMutedVersion(): { version: string; count: number | null } {
  return useSyncExternalStore(subscribeVersionStore, readVersionSnapshot, readVersionSnapshot)
}

// The switch is per browser.
let hiddenCurrent: boolean | null = null
const hiddenListeners = new Set<() => void>()

function loadHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

function readHidden(): boolean {
  if (hiddenCurrent === null) hiddenCurrent = loadHidden()
  return hiddenCurrent
}

function subscribeHidden(listener: () => void): () => void {
  hiddenListeners.add(listener)
  return () => hiddenListeners.delete(listener)
}

export function setMutedIpsHidden(on: boolean): void {
  hiddenCurrent = on
  try {
    localStorage.setItem(HIDDEN_STORAGE_KEY, String(on))
  } catch {
    // Storage may be blocked; keep the in-memory switch for this session.
  }
  hiddenListeners.forEach((listener) => listener())
}

/** The switch's current value without React, for tests. */
export function readMutedIpsHiddenForTests(): boolean {
  return readHidden()
}

export function useMutedIpsHidden(): [boolean, (on: boolean) => void] {
  const hidden = useSyncExternalStore(subscribeHidden, readHidden, () => true)
  return [hidden, setMutedIpsHidden]
}

export type MutedKeyFields = { excludeMutedIps?: true; mutedIpsVersion?: string }

export function mutedKeyFields(scope: MutedScope): MutedKeyFields {
  return scope.flag ? { excludeMutedIps: true, mutedIpsVersion: scope.version } : {}
}

export function findMutedFields(value: unknown, depth = 0): MutedKeyFields {
  if (depth > 4 || value === null || typeof value !== "object") return {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findMutedFields(entry, depth + 1)
      if (found.excludeMutedIps) return found
    }
    return {}
  }
  const record = value as Record<string, unknown>
  if (record.excludeMutedIps === true && typeof record.mutedIpsVersion === "string") {
    return { excludeMutedIps: true, mutedIpsVersion: record.mutedIpsVersion }
  }
  for (const entry of Object.values(record)) {
    const found = findMutedFields(entry, depth + 1)
    if (found.excludeMutedIps) return found
  }
  return {}
}

/**
 * The placeholderData callback for queries that keep previous results: it
 * returns them only when the flag and the list version match, except for the
 * move from a write's unknown version to the confirmed version of the GET
 * that started after that same write.
 */
export function keepIfSameMuted(fields: MutedKeyFields) {
  return <T>(
    previous: T | undefined,
    previousQuery?: { queryKey: readonly unknown[] },
  ): T | undefined => {
    if (previous === undefined || previousQuery === undefined) return undefined
    const before = findMutedFields(previousQuery.queryKey)
    if (before.excludeMutedIps !== fields.excludeMutedIps) return undefined
    if (before.mutedIpsVersion === fields.mutedIpsVersion) return previous
    const pair = getVersionStore().confirmedFromWrite
    const isWriteThenConfirm =
      pair !== null && before.mutedIpsVersion === pair.from && fields.mutedIpsVersion === pair.to
    return isWriteThenConfirm ? previous : undefined
  }
}

export const MUTED_IPS_CAP = 20

const MUTED_IP_ERROR_MESSAGES: Record<string, string> = {
  muted_ip_exists: "That IP or range is already muted.",
  muted_ip_list_full: `The list is full (${MUTED_IPS_CAP} entries). Remove one first.`,
  invalid_network: "Enter an IP address or CIDR range.",
  invalid_note: "Keep the note to 100 characters.",
}

export function mutedIpErrorMessage(code: string | undefined): string {
  return code && Object.hasOwn(MUTED_IP_ERROR_MESSAGES, code)
    ? MUTED_IP_ERROR_MESSAGES[code]
    : "Couldn't save. Try again."
}

/** The server's `invalid_network` detail names the fix, such as the start of the range the user meant. */
export function mutedIpAddErrorMessage(error: unknown): string {
  const code = mutedIpCodeOf(error)
  if (
    code === "invalid_network" &&
    error &&
    typeof error === "object" &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail
  )
    return error.detail
  return mutedIpErrorMessage(code)
}

/** The generated client throws the parsed error envelope, so `code` sits on the error itself. */
export function mutedIpCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code
  return undefined
}

/** The entry as the IP filter shows it: one address without its /32 or /128. */
export function mutedFilterValue(network: string): string {
  const fullLength = network.includes(":") ? "/128" : "/32"
  return network.endsWith(fullLength) ? network.slice(0, -fullLength.length) : network
}

export function mutedIpsCountLine(count: number): string {
  return `${count} of ${MUTED_IPS_CAP}`
}

export function mutedIpsHomeLine(count: number | undefined): string {
  return count ? `${count} muted` : "None"
}

/** The entry that takes focus once `removedId` leaves the list: the one below it, else the one above. */
export function focusIdAfterRemoval(ids: string[], removedId: string): string | null {
  const index = ids.indexOf(removedId)
  if (index === -1) return null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

export type MuteAction = { kind: "mute" } | { kind: "unmute"; id: string }

/** Unmute only for an exact single-IP entry; an IP a range covers is muted by adding its own entry. */
export function muteAction(ip: string, entries: MutedIpView[]): MuteAction {
  const canonical = canonicalIp(ip)
  if (canonical === null) return { kind: "mute" }
  const network = `${canonical}/${canonical.includes(":") ? 128 : 32}`
  const match = entries.find((entry) => entry.network === network)
  return match ? { kind: "unmute", id: match.id } : { kind: "mute" }
}

/** True while the list is unread or a write is unconfirmed, so the menu cannot tell mute from unmute. */
export function mutedListPending(version: string, entries: MutedIpView[] | undefined): boolean {
  return entries === undefined || version.startsWith(UNKNOWN_PREFIX)
}

export type UnmuteResult = { ok: true } | { ok: false; message: string }

/** A 404 means the entry is gone already, from another device or a second click, so it counts as unmuted. */
export async function runUnmute(
  remove: (id: string) => Promise<unknown>,
  id: string,
): Promise<UnmuteResult> {
  try {
    await remove(id)
    return { ok: true }
  } catch (error) {
    if (error && typeof error === "object" && "status_code" in error && error.status_code === 404)
      return { ok: true }
    return { ok: false, message: mutedIpErrorMessage(mutedIpCodeOf(error)) }
  }
}

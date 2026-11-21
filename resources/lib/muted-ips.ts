import { useSyncExternalStore } from "react"
import type { Query } from "@tanstack/react-query"

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
  writeStoredVersion(version)
  updateStore({
    unconfirmed: false,
    confirmed: { version, count: networks.length },
    attempted: true,
    stored: version,
  })
}

export function noteFirstLoadFailed(): void {
  const current = getVersionStore()
  if (current.confirmed || current.unconfirmed) {
    updateStore({ attempted: true })
    return
  }
  updateStore({ attempted: true, unknownCounter: current.unknownCounter + 1 })
}

export function markUnconfirmed(): void {
  writeSequence += 1
  writeStoredVersion(null)
  updateStore({
    unconfirmed: true,
    stored: null,
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

// The switch is per browser and read by three pages plus Settings.
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

export function useMutedIpsHidden(): [boolean, (on: boolean) => void] {
  const hidden = useSyncExternalStore(subscribeHidden, readHidden, () => true)
  return [hidden, setMutedIpsHidden]
}

export type MutedKeyFields = { excludeMutedIps?: true; mutedIpsVersion?: string }

export function mutedKeyFields(scope: MutedScope): MutedKeyFields {
  return scope.flag ? { excludeMutedIps: true, mutedIpsVersion: scope.version } : {}
}

function findMutedFields(value: unknown, depth = 0): MutedKeyFields {
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
 * move from a write's unknown version to the confirmed one that follows it.
 */
export function keepIfSameMuted(fields: MutedKeyFields) {
  return <T>(previous: T | undefined, previousQuery?: Query): T | undefined => {
    if (previous === undefined || previousQuery === undefined) return undefined
    const before = findMutedFields(previousQuery.queryKey)
    if (before.excludeMutedIps !== fields.excludeMutedIps) return undefined
    if (before.mutedIpsVersion === fields.mutedIpsVersion) return previous
    const wasUnknown = before.mutedIpsVersion?.startsWith(UNKNOWN_PREFIX) === true
    const isConfirmed = fields.mutedIpsVersion?.startsWith(UNKNOWN_PREFIX) === false
    return wasUnknown && isConfirmed ? previous : undefined
  }
}

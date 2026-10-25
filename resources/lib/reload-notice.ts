/**
 * Whether the server behind this page now runs a newer build, and the version
 * to name when it does. Once pending it stays pending until the page reloads.
 */
import { useSyncExternalStore } from "react"
import { displayVersion } from "@/lib/version"

export interface ReloadNoticeState {
  pending: boolean
  version: string | null
  toastOpen: boolean
}

const INITIAL_STATE: ReloadNoticeState = { pending: false, version: null, toastOpen: false }

let state = INITIAL_STATE
let toastClaimed = false
const listeners = new Set<() => void>()

function setState(nextState: ReloadNoticeState): void {
  state = nextState
  for (const listener of listeners) listener()
}

export function getReloadNoticeState(): ReloadNoticeState {
  return state
}

export function subscribeReloadNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useReloadNotice(): ReloadNoticeState {
  return useSyncExternalStore(subscribeReloadNotice, getReloadNoticeState)
}

/** True only on the call that turned the notice pending. A null version never erases a known one. */
export function markUpdatePending(version: string | null): boolean {
  const wasPending = state.pending
  const nextVersion = version ?? state.version
  if (!wasPending || nextVersion !== state.version) {
    setState({ ...state, pending: true, version: nextVersion })
  }
  return !wasPending
}

export function nameUpdateVersion(version: string): void {
  if (!state.pending || state.version === version) return
  setState({ ...state, version })
}

/** True once per page life, and only while an update is pending. */
export function claimReloadToast(): boolean {
  if (!state.pending || toastClaimed) return false
  toastClaimed = true
  setState({ ...state, toastOpen: true })
  return true
}

export function closeReloadToast(): void {
  if (!state.toastOpen) return
  setState({ ...state, toastOpen: false })
}

export function reloadNoticeTitle(version: string | null): string {
  return version === null ? "A new version is ready" : `${displayVersion(version)} ready`
}

export function reloadNoticeTooltip(version: string | null): string {
  return `${reloadNoticeTitle(version)}, click to reload`
}

export function reloadToastMessage(version: string | null): string {
  return version === null ? "A new version is ready. Reload to use it." : `Updated to ${displayVersion(version)}. Reload to use it.`
}

export function resetReloadNoticeForTests(): void {
  state = INITIAL_STATE
  toastClaimed = false
  listeners.clear()
}

/**
 * What the update hook does on each signal: a health poll, a service worker
 * update, a pending notice. Kept apart from React and the API client so the
 * decisions run under test.
 */
import { createReloadGuard, type IdleReloader, type ReloadGuard } from "@/lib/auto-reload"
import { getReloadNoticeState, markUpdatePending, nameUpdateVersion, subscribeReloadNotice } from "@/lib/reload-notice"
import { createUpdateDetector, type BuildIdentity, type UpdateDetector } from "@/lib/update-detector"

export interface UpdateWiringDeps {
  readServerBuild: () => Promise<BuildIdentity>
  now: () => number
  reportError: (wiringError: unknown) => void
  reloadGuard?: ReloadGuard
}

export interface UpdateWiring {
  detector: UpdateDetector
  canAutoReload(): boolean
  start(): Promise<void>
  serviceWorkerUpdated(): Promise<void>
  pollSucceeded(startedAt: string | null): Promise<void>
  pollFailed(): void
  attachIdleReloader(idleReloader: IdleReloader): () => void
}

export function createUpdateWiring(deps: UpdateWiringDeps): UpdateWiring {
  const reloadGuard = deps.reloadGuard ?? createReloadGuard()
  let attachedReloader: IdleReloader | null = null

  const detector = createUpdateDetector({
    readServerBuild: deps.readServerBuild,
    onServerBuild: (buildIdentity, isNewBuild) => {
      // Lift the guard before marking pending: arm() can reload synchronously.
      if (detector.lastStartedAtChangeAt() !== null) reloadGuard.restartObserved()
      if (isNewBuild) markUpdatePending(buildIdentity.version)
      else nameUpdateVersion(buildIdentity.version)
    },
    now: deps.now,
  })

  function clearGuardOnceKnown(): void {
    const pageBuildKey = detector.pageBuildKey()
    if (pageBuildKey !== null) reloadGuard.pageKeyKnown(pageBuildKey)
  }

  return {
    detector,
    canAutoReload: () => reloadGuard.allows(detector.pageBuildKey()),
    start: () => detector.start().then(clearGuardOnceKnown, deps.reportError),
    serviceWorkerUpdated: () => detector.recheck().then(clearGuardOnceKnown, deps.reportError),
    pollSucceeded: (startedAt) =>
      detector
        .observeStartedAt(startedAt)
        .then(clearGuardOnceKnown, deps.reportError)
        .then(() => attachedReloader?.checkSettled()),
    // A page that comes back during a restart was visible when the server
    // returned, so the update it then finds must not reload it at once.
    pollFailed: () => attachedReloader?.checkSettled(),
    attachIdleReloader(idleReloader) {
      attachedReloader = idleReloader
      const armWhenPending = () => {
        if (getReloadNoticeState().pending) idleReloader.arm()
      }
      armWhenPending()
      const unsubscribe = subscribeReloadNotice(armWhenPending)
      return () => {
        unsubscribe()
        if (attachedReloader === idleReloader) attachedReloader = null
      }
    },
  }
}

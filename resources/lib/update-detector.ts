/**
 * Spots a server that now runs a different build than the page does. The
 * page's own build is whatever the server reported when the page started, so
 * the comparison needs no build-time constant.
 */
import { isLocalBuild } from "@/lib/version"

export interface BuildIdentity {
  version: string
  changelogDigest: string | null
}

/**
 * A local build has no real version, so its changelog digest tells two
 * rebuilds apart. Every other build is identified by its version.
 */
export function buildKey(buildIdentity: BuildIdentity): string {
  return isLocalBuild(buildIdentity.version) ? (buildIdentity.changelogDigest ?? buildIdentity.version) : buildIdentity.version
}

export interface UpdateDetectorDeps {
  readServerBuild: () => Promise<BuildIdentity>
  onServerBuild: (buildIdentity: BuildIdentity, isNewBuild: boolean) => void
  /** Runs at each startedAt change, before the build read that change starts. */
  onStartedAtChange?: () => void
  now: () => number
}

export interface UpdateDetector {
  start(): Promise<void>
  observeStartedAt(startedAt: string | null): Promise<void>
  recheck(): Promise<void>
  pageBuildKey(): string | null
  lastStartedAtChangeAt(): number | null
}

export function createUpdateDetector(deps: UpdateDetectorDeps): UpdateDetector {
  let pageKey: string | null = null
  let baselineStartedAt: string | null = null
  let needsRecheck = false
  let changeAt: number | null = null
  let startRead: Promise<void> | null = null
  let serverRead: Promise<void> | null = null

  function start(): Promise<void> {
    if (pageKey !== null) return Promise.resolve()
    startRead ??= deps
      .readServerBuild()
      .then((buildIdentity) => {
        pageKey ??= buildKey(buildIdentity)
      })
      .finally(() => {
        startRead = null
      })
    return startRead
  }

  function readServer(): Promise<void> {
    if (serverRead !== null) return serverRead
    needsRecheck = false
    serverRead = (async () => {
      let buildIdentity: BuildIdentity
      try {
        buildIdentity = await deps.readServerBuild()
      } catch {
        needsRecheck = true
        return
      }
      deps.onServerBuild(buildIdentity, buildKey(buildIdentity) !== pageKey)
    })().finally(() => {
      serverRead = null
    })
    return serverRead
  }

  async function observeStartedAt(startedAt: string | null): Promise<void> {
    if (startedAt === null) return
    if (pageKey === null) {
      try {
        await start()
      } catch {
        return
      }
    }
    if (baselineStartedAt === null) {
      baselineStartedAt = startedAt
    } else if (startedAt !== baselineStartedAt) {
      baselineStartedAt = startedAt
      needsRecheck = true
      changeAt = deps.now()
      deps.onStartedAtChange?.()
    }
    if (needsRecheck) await readServer()
  }

  async function recheck(): Promise<void> {
    if (pageKey === null) {
      try {
        await start()
      } catch {
        return
      }
    }
    await readServer()
  }

  return {
    start,
    observeStartedAt,
    recheck,
    pageBuildKey: () => pageKey,
    lastStartedAtChangeAt: () => changeAt,
  }
}

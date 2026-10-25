import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchAbout, fetchHealth, fetchRuntimeSettings } from "@/lib/api"
import {
  autoReloadPage,
  createIdleReloader,
  createPreloadErrorHandler,
  createReloadGuard,
  isTextEntryElement,
  latchFirstReload,
  loadPage,
  reloadPage,
  type IdleReloader,
} from "@/lib/auto-reload"
import { getReloadNoticeState, markUpdatePending, nameUpdateVersion, subscribeReloadNotice } from "@/lib/reload-notice"
import { createUpdateDetector, type BuildIdentity } from "@/lib/update-detector"
import { isLocalBuild } from "@/lib/version"

export async function readServerBuild(): Promise<BuildIdentity> {
  const runtimeSettings = await fetchRuntimeSettings()
  if (!isLocalBuild(runtimeSettings.version)) {
    return { version: runtimeSettings.version, changelogDigest: null }
  }
  const aboutResponse = await fetchAbout()
  return { version: runtimeSettings.version, changelogDigest: aboutResponse.app.changelogDigest }
}

const reloadGuard = createReloadGuard()

const detector = createUpdateDetector({
  readServerBuild,
  onServerBuild: (buildIdentity, isNewBuild) => {
    // Lift the guard before marking pending: arm() can reload synchronously.
    if (detector.lastStartedAtChangeAt() !== null) reloadGuard.restartObserved()
    if (isNewBuild) markUpdatePending(buildIdentity.version)
    else nameUpdateVersion(buildIdentity.version)
  },
  now: () => Date.now(),
})

function clearGuardOnceKnown(): void {
  const pageBuildKey = detector.pageBuildKey()
  if (pageBuildKey !== null) reloadGuard.pageKeyKnown(pageBuildKey)
}

function canAutoReload(): boolean {
  return reloadGuard.allows(detector.pageBuildKey())
}

const autoReload = latchFirstReload(() => autoReloadPage(detector.pageBuildKey()))

function reportDetectorError(detectorError: unknown): void {
  console.error("Update detector failed", detectorError)
}

export function reloadNow(): void {
  reloadPage(detector.pageBuildKey())
}

export function loadNow(href: string): void {
  loadPage(detector.pageBuildKey(), href)
}

export function useUpdateDetector(): void {
  const idleReloaderRef = useRef<IdleReloader | null>(null)
  const { data: healthResponse, dataUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
    retry: 1,
  })

  useEffect(() => {
    detector.start().then(clearGuardOnceKnown, reportDetectorError)

    const idleReloader = createIdleReloader({
      events: document,
      visibilityState: () => document.visibilityState,
      textEntryFocused: () => isTextEntryElement(document.activeElement as HTMLElement | null),
      canAutoReload,
      reload: autoReload,
    })
    idleReloaderRef.current = idleReloader

    const onPreloadError = createPreloadErrorHandler({
      isPending: () => getReloadNoticeState().pending,
      lastStartedAtChangeAt: detector.lastStartedAtChangeAt,
      now: () => Date.now(),
      canAutoReload,
      reload: autoReload,
    })
    window.addEventListener("vite:preloadError", onPreloadError)

    const armWhenPending = () => {
      const noticeState = getReloadNoticeState()
      if (!noticeState.pending) return
      idleReloader.arm()
      if (noticeState.version === null) detector.recheck().then(clearGuardOnceKnown, reportDetectorError)
    }
    armWhenPending()
    const unsubscribe = subscribeReloadNotice(armWhenPending)

    return () => {
      unsubscribe()
      window.removeEventListener("vite:preloadError", onPreloadError)
      idleReloader.dispose()
      idleReloaderRef.current = null
    }
  }, [])

  useEffect(() => {
    if (healthResponse === undefined) return
    detector
      .observeStartedAt(healthResponse.startedAt)
      .then(clearGuardOnceKnown, reportDetectorError)
      .then(() => idleReloaderRef.current?.checkSettled())
  }, [healthResponse, dataUpdatedAt])
}

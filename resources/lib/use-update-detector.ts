import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchAbout, fetchHealth, fetchRuntimeSettings } from "@/lib/api"
import {
  autoReloadPage,
  createIdleReloader,
  createPreloadErrorHandler,
  isTextEntryElement,
  latchFirstReload,
  loadPage,
  reloadPage,
} from "@/lib/auto-reload"
import { getReloadNoticeState } from "@/lib/reload-notice"
import { onServiceWorkerUpdate } from "@/lib/sw-register"
import type { BuildIdentity } from "@/lib/update-detector"
import { createUpdateWiring } from "@/lib/update-wiring"
import { isLocalBuild } from "@/lib/version"

export async function readServerBuild(): Promise<BuildIdentity> {
  const runtimeSettings = await fetchRuntimeSettings()
  if (!isLocalBuild(runtimeSettings.version)) {
    return { version: runtimeSettings.version, changelogDigest: null }
  }
  const aboutResponse = await fetchAbout()
  return { version: runtimeSettings.version, changelogDigest: aboutResponse.app.changelogDigest }
}

function reportWiringError(wiringError: unknown): void {
  console.error("Update detector failed", wiringError)
}

const wiring = createUpdateWiring({
  readServerBuild,
  now: () => Date.now(),
  reportError: reportWiringError,
})
const { detector } = wiring

const autoReload = latchFirstReload(() => autoReloadPage(detector.pageBuildKey()))

export function reloadNow(): void {
  reloadPage(detector.pageBuildKey())
}

export function loadNow(href: string): void {
  loadPage(detector.pageBuildKey(), href)
}

export function useUpdateDetector(): void {
  const { data: healthResponse, dataUpdatedAt, errorUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
    retry: 1,
  })

  useEffect(() => {
    void wiring.start()

    const idleReloader = createIdleReloader({
      events: document,
      visibilityState: () => document.visibilityState,
      textEntryFocused: () => isTextEntryElement(document.activeElement as HTMLElement | null),
      canAutoReload: wiring.canAutoReload,
      reload: autoReload,
    })

    const onPreloadError = createPreloadErrorHandler({
      isPending: () => getReloadNoticeState().pending,
      lastStartedAtChangeAt: detector.lastStartedAtChangeAt,
      now: () => Date.now(),
      canAutoReload: wiring.canAutoReload,
      reload: autoReload,
    })
    window.addEventListener("vite:preloadError", onPreloadError)

    const detachIdleReloader = wiring.attachIdleReloader(idleReloader)
    const unsubscribeServiceWorker = onServiceWorkerUpdate(() => void wiring.serviceWorkerUpdated())

    return () => {
      unsubscribeServiceWorker()
      detachIdleReloader()
      window.removeEventListener("vite:preloadError", onPreloadError)
      idleReloader.dispose()
    }
  }, [])

  useEffect(() => {
    if (healthResponse === undefined) return
    void wiring.pollSucceeded(healthResponse.startedAt)
  }, [healthResponse, dataUpdatedAt])

  useEffect(() => {
    if (errorUpdatedAt === 0) return
    wiring.pollFailed()
  }, [errorUpdatedAt])
}

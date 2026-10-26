import type { RegisterSWOptions } from "vite-plugin-pwa/types"

let updateListener: (() => void) | null = null
let updateMissed = false

/**
 * A new worker only means the server may run a new build: a page that just
 * reloaded onto that build sees the same event while the old worker still
 * controls it. Listeners compare builds instead of trusting the event.
 */
export function onServiceWorkerUpdate(listener: () => void): () => void {
  updateListener = listener
  if (updateMissed) {
    updateMissed = false
    listener()
  }
  return () => {
    if (updateListener === listener) updateListener = null
  }
}

function reportServiceWorkerUpdate(): void {
  if (updateListener === null) updateMissed = true
  else updateListener()
}

export function swRegisterOptions(): RegisterSWOptions {
  return {
    immediate: true,
    // Without onNeedReload the plugin calls window.location.reload() itself
    // when a new service worker activates, under the user's hands.
    onNeedReload: reportServiceWorkerUpdate,
  }
}

export function resetServiceWorkerUpdateForTests(): void {
  updateListener = null
  updateMissed = false
}

import type { RegisterSWOptions } from "vite-plugin-pwa/types"
import { markUpdatePending } from "@/lib/reload-notice"

export function swRegisterOptions(): RegisterSWOptions {
  return {
    immediate: true,
    // Without onNeedReload the plugin calls window.location.reload() itself
    // when a new service worker activates, under the user's hands.
    onNeedReload: () => void markUpdatePending(null),
  }
}

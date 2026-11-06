import type { Page } from "@playwright/test"

export type SafeAreaInsets = { left: number; right: number; bottom: number }

/** A large iPhone held sideways: the notch side and the opposite side both report about 59px. */
export const IPHONE_LANDSCAPE_INSETS: SafeAreaInsets = { left: 59, right: 59, bottom: 21 }

/** Makes env(safe-area-inset-*) resolve to these values in Chromium. */
export async function emulateSafeAreas(page: Page, insets: SafeAreaInsets): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets })
}

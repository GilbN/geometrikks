import { handleMenuClick } from "./menus"
import { handleOmniboxEnter, handleOmniboxInput } from "./omnibox"
import { currentConnection, type WorkerDeps } from "./pending-flow"

/** Playwright can't open Chrome's native menus or address bar, so the e2e
 *  build exposes the handlers on `globalThis.__gmk`. */
export function installE2eHooks(deps: WorkerDeps): void {
  if (import.meta.env.MODE === "e2e") {
    Object.assign(globalThis, {
      __gmk: {
        handleMenuClick: (
          info: Pick<chrome.contextMenus.OnClickData, "menuItemId" | "selectionText">,
          tab?: chrome.tabs.Tab,
        ) => handleMenuClick(info, tab, deps),
        handleOmniboxInput: async (text: string) => {
          let suggestions: chrome.omnibox.SuggestResult[] = []
          await handleOmniboxInput(
            text,
            (rows) => {
              suggestions = rows
            },
            deps,
          )
          return suggestions
        },
        handleOmniboxEnter: (
          text: string,
          disposition: `${chrome.omnibox.OnInputEnteredDisposition}` = "currentTab",
        ) => handleOmniboxEnter(text, disposition, deps),
        checkConnection: async () => {
          const stored = await currentConnection(deps.chrome)
          if (stored === null) return null
          return deps.fetchConnection({ origin: stored.origin, key: stored.key })
        },
      },
    })
  }
}

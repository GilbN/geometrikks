import { installE2eHooks } from "./e2e-hooks"
import { handleMenuClick, handleRefreshConnection, rebuildMenus } from "./menus"
import { handleOmniboxEnter, handleOmniboxInput } from "./omnibox"
import {
  claimPending,
  claimRequestFrom,
  clearPending,
  createWorkerDeps,
  deliverPending,
  refreshFrom,
} from "./pending-flow"

const deps = createWorkerDeps()

async function settle(event: string, job: () => Promise<unknown>): Promise<void> {
  try {
    await job()
  } catch (error) {
    console.error(`GeoMetrikks: ${event} failed`, error)
  }
}

async function answer(message: Record<string, unknown>): Promise<unknown> {
  switch (message.type) {
    case "claimPending": {
      const request = claimRequestFrom(message)
      return request ? claimPending(request, deps) : null
    }
    case "serverChanged":
      await clearPending(deps)
      return null
    case "refreshConnection": {
      const refresh = refreshFrom(message)
      return refresh ? handleRefreshConnection(refresh.fresh, refresh.started, deps) : false
    }
    default:
      return null
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void settle("menu rebuild", () => rebuildMenus(deps))
  if (details.reason === "install")
    void settle("opening Options", () => deps.chrome.runtime.openOptionsPage())
})

chrome.runtime.onStartup.addListener(() => {
  void settle("menu rebuild", () => rebuildMenus(deps))
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "connection" in changes)
    void settle("menu rebuild", () => rebuildMenus(deps))
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null)
    return false
  void (async () => {
    let response: unknown = null
    await settle("message", async () => {
      response = await answer(message as Record<string, unknown>)
    })
    sendResponse(response)
  })()
  return true
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void settle("menu click", async () => {
    const item = await handleMenuClick(info, tab, deps)
    if (item) await deliverPending(item, deps)
  })
})

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  void settle("address bar suggestions", () => handleOmniboxInput(text, suggest, deps))
})

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  void settle("address bar entry", () => handleOmniboxEnter(text, disposition, deps))
})

installE2eHooks(deps)

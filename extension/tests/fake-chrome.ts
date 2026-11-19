import type { ChromeApi, StorageAreaApi } from "../src/lib/chrome-api"

export interface FakeStorageArea extends StorageAreaApi {
  data: Record<string, unknown>
}

function fakeStorageArea(initial: Record<string, unknown> = {}): FakeStorageArea {
  const data: Record<string, unknown> = structuredClone(initial)
  return {
    data,
    async get(keys) {
      const wanted = keys === null ? Object.keys(data) : typeof keys === "string" ? [keys] : keys
      return Object.fromEntries(
        wanted.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]),
      )
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data[key] = structuredClone(value)
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete data[key]
    },
  }
}

export interface FakeChrome extends ChromeApi {
  storage: { local: FakeStorageArea; session: FakeStorageArea }
  /** Origins patterns currently granted. */
  granted: Set<string>
  /** Every call, in order, as `"area.method"` with its first argument. */
  calls: { name: string; arg: unknown }[]
}

/** An in-memory `ChromeApi`. Methods record their calls; override any of them per test. */
export function fakeChrome(
  init: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {},
): FakeChrome {
  const calls: FakeChrome["calls"] = []
  const granted = new Set<string>()
  const record = (name: string, arg?: unknown) => calls.push({ name, arg })
  let menuId = 0
  return {
    calls,
    granted,
    storage: { local: fakeStorageArea(init.local), session: fakeStorageArea(init.session) },
    permissions: {
      async contains(permissions) {
        record("permissions.contains", permissions)
        return (permissions.origins ?? []).every((origin) => granted.has(origin))
      },
      async request(permissions) {
        record("permissions.request", permissions)
        for (const origin of permissions.origins ?? []) granted.add(origin)
        return true
      },
      async remove(permissions) {
        record("permissions.remove", permissions)
        for (const origin of permissions.origins ?? []) granted.delete(origin)
        return true
      },
    },
    tabs: {
      async query(queryInfo) {
        record("tabs.query", queryInfo)
        return []
      },
      async create(createProperties) {
        record("tabs.create", createProperties)
        return { id: 1, index: 0, windowId: createProperties.windowId ?? 1 } as chrome.tabs.Tab
      },
      async update(updateProperties) {
        record("tabs.update", updateProperties)
        return undefined
      },
    },
    windows: {
      async getCurrent() {
        record("windows.getCurrent")
        return { id: 1 } as chrome.windows.Window
      },
      async create(createData) {
        record("windows.create", createData)
        return { id: 2 } as chrome.windows.Window
      },
    },
    action: {
      async openPopup(options) {
        record("action.openPopup", options)
      },
    },
    contextMenus: {
      create(createProperties) {
        record("contextMenus.create", createProperties)
        return createProperties.id ?? ++menuId
      },
      async removeAll() {
        record("contextMenus.removeAll")
      },
    },
    omnibox: {
      async setDefaultSuggestion(suggestion) {
        record("omnibox.setDefaultSuggestion", suggestion)
      },
    },
    runtime: {
      async sendMessage(message) {
        record("runtime.sendMessage", message)
        return undefined
      },
      async openOptionsPage() {
        record("runtime.openOptionsPage")
      },
      getURL(path) {
        return `chrome-extension://fake/${path.replace(/^\//, "")}`
      },
    },
  }
}

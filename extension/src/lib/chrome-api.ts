export interface StorageAreaApi {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

/** The part of `chrome.*` the extension uses, promise forms only, so tests can pass fakes. */
export interface ChromeApi {
  storage: { local: StorageAreaApi; session: StorageAreaApi }
  permissions: {
    contains(permissions: chrome.permissions.Permissions): Promise<boolean>
    request(permissions: chrome.permissions.Permissions): Promise<boolean>
    remove(permissions: chrome.permissions.Permissions): Promise<boolean>
  }
  tabs: {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>
    create(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>
    update(updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
  }
  windows: {
    getCurrent(): Promise<chrome.windows.Window>
    create(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>
  }
  action: { openPopup(options: chrome.action.OpenPopupOptions): Promise<void> }
  contextMenus: {
    create(createProperties: chrome.contextMenus.CreateProperties): number | string
    removeAll(): Promise<void>
  }
  omnibox: {
    setDefaultSuggestion(suggestion: chrome.omnibox.DefaultSuggestResult): Promise<void>
  }
  runtime: {
    sendMessage(message: unknown): Promise<unknown>
    openOptionsPage(): Promise<void>
    getURL(path: string): string
  }
}

/** Getters, so importing this module outside Chrome (unit tests) never touches `chrome`. */
export const realChrome: ChromeApi = {
  get storage() {
    return chrome.storage
  },
  get permissions() {
    return chrome.permissions
  },
  get tabs() {
    return chrome.tabs
  },
  get windows() {
    return chrome.windows
  },
  get action() {
    return chrome.action
  },
  get contextMenus() {
    return chrome.contextMenus
  },
  get omnibox() {
    return chrome.omnibox
  },
  get runtime() {
    return chrome.runtime
  },
}

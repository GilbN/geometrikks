import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  chromium,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Route,
  type Worker,
} from "@playwright/test"

const ROOT = path.resolve(import.meta.dirname, "../..")
export const DIST = path.join(ROOT, "extension", "dist-e2e")
export const SCREENS = path.join(ROOT, "tests", "extension", "__screens__")

function required(name: string): string {
  const value = process.env[name]
  if (!value)
    throw new Error(
      `${name} is not set. Start scripts/extension-e2e-server.sh and source the keys.env it prints.`,
    )
  return value
}

export const env = {
  origin: required("E2E_ORIGIN"),
  rwKey: required("E2E_RW_KEY"),
  readKey: required("E2E_READ_KEY"),
}
export const serverHost = new URL(env.origin).host

export const SITE = "photos.example.net"
export const SITE_STATS_PATHS = ["time-series", "top-ips", "top-countries", "top-urls"] as const

export interface Extension {
  context: BrowserContext
  id: string
  worker: Worker
  /** Every request URL the context's pages made, oldest first. */
  requests: string[]
  /** Console errors and page errors, with the page URL that logged them. */
  errors: string[]
}

/** The admin API, for keys the tests make and revoke themselves. */
export async function adminApi(): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({
    baseURL: env.origin,
    ignoreHTTPSErrors: true,
  })
  const login = await api.post("/api/v1/auth/login", {
    data: { username: "admin", password: "admin" },
  })
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()}`)
  return api
}

/** Reads the server with the Read/write key, outside the extension. */
export async function serverGet<T>(pathAndQuery: string): Promise<T> {
  const api = await playwrightRequest.newContext({
    baseURL: env.origin,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Authorization: `Bearer ${env.rwKey}` },
  })
  try {
    const response = await api.get(pathAndQuery)
    if (!response.ok()) throw new Error(`GET ${pathAndQuery}: ${response.status()}`)
    return (await response.json()) as T
  } finally {
    await api.dispose()
  }
}

export interface ConnectionPatch {
  add?: string[]
  remove?: string[]
  appVersion?: string
}

/** Passes `/auth/connection` through and edits its capabilities. The real
 *  `scope` and `mode` stay as the server sent them. Pages only: the worker's
 *  own requests are not routed. */
export async function patchConnection(
  context: BrowserContext,
  patch: ConnectionPatch,
): Promise<void> {
  await context.unroute("**/api/v1/auth/connection")
  await context.route("**/api/v1/auth/connection", async (route: Route) => {
    const response = await route.fetch()
    if (response.status() !== 200) return route.fulfill({ response })
    const body = (await response.json()) as { capabilities: string[]; appVersion: string }
    const capabilities = new Set(body.capabilities)
    for (const capability of patch.add ?? []) capabilities.add(capability)
    for (const capability of patch.remove ?? []) capabilities.delete(capability)
    await route.fulfill({
      response,
      json: {
        ...body,
        capabilities: [...capabilities],
        appVersion: patch.appVersion ?? body.appVersion,
      },
    })
  })
}

export async function openPopup(extension: Extension, search = ""): Promise<Page> {
  const page = await extension.context.newPage()
  await page.setViewportSize({ width: 380, height: 600 })
  await page.goto(`chrome-extension://${extension.id}/popup.html${search}`)
  return page
}

export async function openOptions(extension: Extension): Promise<Page> {
  const url = `chrome-extension://${extension.id}/options.html`
  const page = extension.context.pages().find((open) => open.url() === url)
  if (page) return page
  const opened = await extension.context.newPage()
  await opened.goto(url)
  return opened
}

/** The Connected card's key name, followed by its scope badge. */
export function keyNameCell(options: Page, name: string) {
  return options.locator("dd").filter({ hasText: new RegExp(`^${name}(Read/write|Read)?$`) })
}

/** Connects in Options with `key`, the way a user does. */
export async function connectWith(extension: Extension, key: string, name: string): Promise<Page> {
  const page = await openOptions(extension)
  await page.setViewportSize({ width: 760, height: 900 })
  await page.getByLabel("Server address").fill(env.origin)
  await page.getByLabel("API key").fill(key)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await base
    .expect(page.locator("form").getByRole("status"))
    .toHaveText(`Connected to ${serverHost}.`)
  await base.expect(keyNameCell(page, name)).toBeVisible()
  return page
}

export async function screenshot(page: Page, name: string): Promise<void> {
  // Let toasts and the chart settle before the picture.
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(SCREENS, `e2e-${name}.png`), fullPage: true })
}

export const test = base.extend<
  { extension: Extension },
  { extensionWorker: Omit<Extension, "requests" | "errors"> }
>({
  extensionWorker: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
    async ({}, use) => {
      mkdirSync(SCREENS, { recursive: true })
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), "gmk-ext-e2e-"))
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: "chromium",
        headless: true,
        colorScheme: "dark",
        ignoreHTTPSErrors: true,
        args: [
          `--disable-extensions-except=${DIST}`,
          `--load-extension=${DIST}`,
          "--ignore-certificate-errors",
        ],
      })
      let [worker] = context.serviceWorkers()
      worker ??= await context.waitForEvent("serviceworker")
      const id = new URL(worker.url()).host
      try {
        await use({ context, id, worker })
      } finally {
        await context.close()
        rmSync(userDataDir, { recursive: true, force: true })
      }
    },
    { scope: "worker" },
  ],
  extension: async ({ extensionWorker }, use) => {
    const requests: string[] = []
    const errors: string[] = []
    const { context } = extensionWorker
    const onRequest = (request: { url(): string }) => requests.push(request.url())
    const watch = (page: Page) => {
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`)
      })
      page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`))
    }
    const onWorkerConsole = (message: ConsoleMessage) => {
      if (message.type() === "error") errors.push(`worker: ${message.text()}`)
    }
    for (const page of context.pages()) watch(page)
    context.on("page", watch)
    extensionWorker.worker.on("console", onWorkerConsole)
    context.on("request", onRequest)
    try {
      await use({ ...extensionWorker, requests, errors })
    } finally {
      context.off("page", watch)
      extensionWorker.worker.off("console", onWorkerConsole)
      context.off("request", onRequest)
      await context.unrouteAll({ behavior: "ignoreErrors" })
      for (const page of context.pages())
        if (page.url().startsWith("chrome-extension:")) await page.close()
    }
  },
})

export const expect = test.expect

/** Chrome logs every 4xx and failed request as a console error; the problem
 *  screens make them on purpose. */
export function appErrors(errors: string[]): string[] {
  return errors.filter((error) => !error.includes("Failed to load resource"))
}

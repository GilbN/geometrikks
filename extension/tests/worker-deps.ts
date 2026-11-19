import { vi } from "vite-plus/test"
import type { WorkerDeps } from "../src/background/pending-flow"
import { createSerialQueue } from "../src/lib/pending"
import type { ConnectionResponse, StoredConnection } from "../src/lib/storage"
import { fakeChrome, type FakeChrome } from "./fake-chrome"

export const A = "https://a.example"
export const A_PATTERN = "https://a.example:443/*"
export const B = "https://b.example"
export const B_PATTERN = "https://b.example:443/*"

export const writeAnswer: ConnectionResponse = {
  mode: "apiKey",
  appVersion: "0.26.0",
  apiVersion: "1",
  capabilities: ["crowdsec", "crowdsecWrite", "drop"],
  name: "Laptop Chrome",
  scope: "read_write",
  expiresAt: null,
}

export const readAnswer: ConnectionResponse = { ...writeAnswer, scope: "read" }

export const noWriteAnswer: ConnectionResponse = { ...writeAnswer, capabilities: ["crowdsec"] }

export function storedFor(
  origin: string,
  overrides: Partial<StoredConnection> = {},
): StoredConnection {
  return {
    origin,
    pattern: origin === A ? A_PATTERN : B_PATTERN,
    key: "gmk_rw",
    keyless: false,
    verifiedScope: "read_write",
    connection: writeAnswer,
    savedAt: 1,
    lifetime: "lifetime-1",
    ...overrides,
  }
}

export interface TestDeps extends WorkerDeps {
  chrome: FakeChrome
  fetchConnection: ReturnType<typeof vi.fn<WorkerDeps["fetchConnection"]>>
  banIp: ReturnType<typeof vi.fn<WorkerDeps["banIp"]>>
}

/** A connected Read/write fake whose checks pass and bans succeed. */
export function testDeps(stored: StoredConnection | null = storedFor(A)): TestDeps {
  const chromeApi = fakeChrome({ local: stored ? { connection: stored } : {} })
  if (stored) chromeApi.granted.add(stored.pattern)
  let clock = 1_000_000
  let ids = 0
  return {
    chrome: chromeApi,
    queue: createSerialQueue(),
    fetchConnection: vi.fn<WorkerDeps["fetchConnection"]>(async () => ({
      ok: true as const,
      connection: writeAnswer,
    })),
    banIp: vi.fn<WorkerDeps["banIp"]>(async (_target, ip, duration) => ({
      ok: true,
      ip,
      durationLabel: duration.label,
      message: `Banned ${ip} for ${duration.label}`,
    })),
    now: () => (clock += 10),
    newId: () => `item-${++ids}`,
  }
}

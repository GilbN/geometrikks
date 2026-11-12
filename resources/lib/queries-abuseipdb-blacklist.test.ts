import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { AbuseIpdbBlacklistResponse } from "@/generated/api/types.gen"

const mocks = vi.hoisted(() => ({
  fetchAbuseIpdbBlacklist: vi.fn(),
  status: undefined as { blacklistEnabled: boolean } | undefined,
  cachedBlacklist: undefined as Set<string> | undefined,
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[1] === "status" ? mocks.status : mocks.cachedBlacklist,
  }),
}))
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchAbuseIpdbBlacklist: mocks.fetchAbuseIpdbBlacklist,
}))
import { abuseIpdbBlacklistQueryOptions, useAbuseIpdbBlacklisted } from "./queries"

const BLACKLIST_KEY = ["abuseipdb", "blacklist"]
const MINUTE_MS = 60_000
const REFRESHED_AT = "2026-11-08T06:05:00Z"

function blacklistResponse(overrides: Partial<AbuseIpdbBlacklistResponse> = {}): AbuseIpdbBlacklistResponse {
  return { generatedAt: "2026-11-08T06:00:00Z", refreshedAt: REFRESHED_AT, ips: ["3.5.140.2"], ...overrides }
}

let queryClient: QueryClient
const unsubscribers: Array<() => void> = []

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.fetchAbuseIpdbBlacklist.mockReset()
  mocks.status = undefined
  mocks.cachedBlacklist = undefined
})

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  queryClient.clear()
})

function observe() {
  const observer = new QueryObserver(queryClient, abuseIpdbBlacklistQueryOptions(true))
  unsubscribers.push(observer.subscribe(() => {}))
  return observer
}

it("stops marking an IP once the feature turns off, though the list stays cached", () => {
  mocks.cachedBlacklist = new Set(["3.5.140.2"])
  mocks.status = { blacklistEnabled: true }
  expect(useAbuseIpdbBlacklisted("3.5.140.2")).toBe(true)

  mocks.status = { blacklistEnabled: false }
  expect(useAbuseIpdbBlacklisted("3.5.140.2")).toBe(false)
})

it("builds one Set per response however many IPs read it", async () => {
  mocks.fetchAbuseIpdbBlacklist.mockResolvedValue(blacklistResponse())
  const observers = Array.from({ length: 5 }, () => observe())
  await vi.waitFor(() => expect(observers.every((observer) => observer.getCurrentResult().data)).toBe(true))
  const blacklistSets = new Set(observers.map((observer) => observer.getCurrentResult().data))
  expect(blacklistSets.size).toBe(1)
  expect(mocks.fetchAbuseIpdbBlacklist).toHaveBeenCalledTimes(1)
  const firstSet = observers[0].getCurrentResult().data

  mocks.fetchAbuseIpdbBlacklist.mockResolvedValue(blacklistResponse({ ips: ["3.5.140.9"] }))
  await queryClient.refetchQueries({ queryKey: BLACKLIST_KEY })
  await vi.waitFor(() => expect(observers[0].getCurrentResult().data).not.toBe(firstSet))
  expect(new Set(observers.map((observer) => observer.getCurrentResult().data)).size).toBe(1)
})

it.each([
  ["keeps an empty answer under a minute old", null, 0.5, false],
  ["refetches an empty answer over a minute old", null, 1.1, true],
  ["keeps a downloaded list under an hour old", REFRESHED_AT, 59, false],
  ["refetches a downloaded list over an hour old", REFRESHED_AT, 61, true],
])("%s", async (_label, refreshedAt, ageMinutes, refetched) => {
  mocks.fetchAbuseIpdbBlacklist.mockResolvedValue(blacklistResponse())
  queryClient.setQueryData(BLACKLIST_KEY, blacklistResponse({ refreshedAt, ips: [] }), {
    updatedAt: Date.now() - ageMinutes * MINUTE_MS,
  })

  observe()
  await new Promise((resolve) => setTimeout(resolve, 20))

  expect(mocks.fetchAbuseIpdbBlacklist).toHaveBeenCalledTimes(refetched ? 1 : 0)
})

it("keeps the list for an hour after its last observer goes away", () => {
  expect(abuseIpdbBlacklistQueryOptions(true).gcTime).toBe(60 * MINUTE_MS)
})

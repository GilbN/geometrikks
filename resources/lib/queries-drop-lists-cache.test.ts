import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { DropListsResponse } from "@/generated/api/types.gen"
const mocks = vi.hoisted(() => ({ buildCalls: 0 }))
vi.mock("./drop-lists", async (importOriginal) => {
  const original = await importOriginal<typeof import("./drop-lists")>()
  return {
    ...original,
    buildDropIndex: (...args: Parameters<typeof original.buildDropIndex>) => {
      mocks.buildCalls++
      return original.buildDropIndex(...args)
    },
  }
})
import { api } from "./api"
import { dropListsQueryOptions } from "./queries"

function dropListsResponse(overrides: Partial<DropListsResponse> = {}): DropListsResponse {
  return {
    enabled: true,
    loaded: true,
    stale: false,
    updatedAt: "2026-11-01T06:00:00Z",
    copyright: null,
    feeds: [],
    asns: [],
    networks: [{ cidr: "192.0.2.0/24", sblId: "SBL000001" }],
    ...overrides,
  }
}

let queryClient: QueryClient
const unsubscribers: Array<() => void> = []
const getDropLists = vi.fn()

beforeEach(() => {
  mocks.buildCalls = 0
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  getDropLists.mockReset()
  vi.spyOn(api, "get").mockImplementation(getDropLists)
})

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  queryClient.clear()
})

function observe(updatedAt: string | null, enabled: boolean) {
  const observer = new QueryObserver(queryClient, dropListsQueryOptions(updatedAt, enabled))
  unsubscribers.push(observer.subscribe(() => {}))
  return observer
}

it("builds the index once per response however many IPs read it", async () => {
  getDropLists.mockResolvedValue({ data: dropListsResponse() })
  const observers = Array.from({ length: 5 }, () => observe("2026-11-01T06:00:00Z", true))
  await vi.waitFor(() => expect(observers.every((observer) => observer.getCurrentResult().data)).toBe(true))
  const dropIndexes = new Set(observers.map((observer) => observer.getCurrentResult().data))
  expect(dropIndexes.size).toBe(1)
  expect(getDropLists).toHaveBeenCalledTimes(1)
  expect(mocks.buildCalls).toBe(1)

  getDropLists.mockResolvedValue({ data: dropListsResponse({ networks: [{ cidr: "198.51.100.0/24", sblId: "SBL000002" }] }) })
  await queryClient.refetchQueries({ queryKey: ["drop", "lists"] })
  await vi.waitFor(() => expect(mocks.buildCalls).toBe(2))
})

it("fetches as soon as About reports a first download", async () => {
  getDropLists.mockResolvedValue({ data: dropListsResponse() })
  const observer = observe(null, false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(getDropLists).not.toHaveBeenCalled()
  observer.setOptions(dropListsQueryOptions("2026-11-01T06:00:00Z", true))
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBeTruthy())
  expect(getDropLists).toHaveBeenCalledTimes(1)
})

it("refetches a cached answer from while DROP was off once it turns back on", async () => {
  getDropLists.mockResolvedValue({ data: dropListsResponse({ enabled: false, networks: [] }) })
  const firstObserver = observe("2026-11-01T06:00:00Z", true)
  await vi.waitFor(() => expect(firstObserver.getCurrentResult().status).toBe("success"))
  expect(firstObserver.getCurrentResult().data).toBeNull()
  firstObserver.setOptions(dropListsQueryOptions("2026-11-01T06:00:00Z", false))

  getDropLists.mockResolvedValue({ data: dropListsResponse() })
  const reenabledObserver = observe("2026-11-01T06:00:00Z", true)
  await vi.waitFor(() => expect(reenabledObserver.getCurrentResult().data).toBeTruthy())
  expect(getDropLists).toHaveBeenCalledTimes(2)
})

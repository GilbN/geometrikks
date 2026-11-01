import { beforeEach, expect, it, vi } from "vitest"
import type { DropListsResponse } from "@/generated/api/types.gen"
type QueryOptions = {
  queryKey: readonly unknown[]
  enabled?: boolean
  staleTime?: number
  refetchInterval?: number
  select?: (dropLists: DropListsResponse) => unknown
}
const mocks = vi.hoisted(() => ({
  options: [] as QueryOptions[],
  about: undefined as unknown,
  dropLists: undefined as DropListsResponse | undefined,
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    mocks.options.push(options)
    if (options.queryKey[0] === "drop") {
      return { data: options.enabled && mocks.dropLists ? options.select!(mocks.dropLists) : undefined }
    }
    return { data: mocks.about }
  },
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}))
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: <T,>(compute: () => T) => compute(),
}))
import { DROP_LISTS_REFETCH_MS, DROP_LISTS_STALE_MS, useDropLists, useDropNetwork } from "./queries"

function dropListsResponse(overrides: Partial<DropListsResponse> = {}): DropListsResponse {
  return {
    enabled: true,
    loaded: true,
    stale: false,
    updatedAt: "2026-11-01T06:00:00Z",
    copyright: null,
    feeds: [],
    asns: [{ asn: 64496, name: "Example" }],
    networks: [{ cidr: "192.0.2.0/24", sblId: "SBL000001" }],
    ...overrides,
  }
}

function aboutWith(dropLists: { enabled: boolean; loaded: boolean } | null) {
  return { dropLists }
}

const dropListsOptions = () => mocks.options.filter((options) => options.queryKey[0] === "drop").at(-1)!

beforeEach(() => {
  mocks.options = []
  mocks.about = aboutWith({ enabled: true, loaded: true })
  mocks.dropLists = dropListsResponse()
})

it("keeps the lists for 30 minutes and refetches hourly", () => {
  useDropLists()
  expect(dropListsOptions().queryKey).toEqual(["drop", "lists"])
  expect(dropListsOptions().staleTime).toBe(DROP_LISTS_STALE_MS)
  expect(DROP_LISTS_STALE_MS).toBe(30 * 60_000)
  expect(dropListsOptions().refetchInterval).toBe(DROP_LISTS_REFETCH_MS)
  expect(DROP_LISTS_REFETCH_MS).toBe(60 * 60_000)
})

it("does not fetch while About is loading, DROP is off, or the lists never downloaded", () => {
  for (const about of [undefined, aboutWith(null), aboutWith({ enabled: false, loaded: true }), aboutWith({ enabled: true, loaded: false })]) {
    mocks.about = about
    expect(useDropLists()).toEqual({ loaded: false })
    expect(dropListsOptions().enabled).toBe(false)
    expect(useDropNetwork("192.0.2.9")).toBeNull()
  }
})

it("marks nothing when the response itself says DROP is off", () => {
  mocks.dropLists = dropListsResponse({ enabled: false })
  expect(useDropLists()).toEqual({ loaded: false })
  expect(useDropNetwork("192.0.2.9")).toBeNull()
})

it("matches an IP once the lists are loaded", () => {
  expect(useDropLists().loaded).toBe(true)
  expect(useDropNetwork("192.0.2.9")).toEqual({ cidr: "192.0.2.0/24", sblId: "SBL000001" })
  expect(useDropNetwork("198.51.100.1")).toBeNull()
})

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { MutedIpView } from "@/generated/api/types.gen"

const mocks = vi.hoisted(() => ({
  fetchMutedIps: vi.fn(),
  addMutedIp: vi.fn(),
  removeMutedIp: vi.fn(),
  queryClient: undefined as unknown,
  mutationOptions: undefined as unknown,
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: (options: unknown) => {
    mocks.mutationOptions = options
  },
  useQueryClient: () => mocks.queryClient,
}))
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchMutedIps: mocks.fetchMutedIps,
  addMutedIp: mocks.addMutedIp,
  removeMutedIp: mocks.removeMutedIp,
}))
import { AxiosError, AxiosHeaders } from "axios"
import { MutationObserver } from "@tanstack/react-query"
import {
  getVersionStore,
  resetMutedIpsStoreForTests,
  resolveVersion,
  listVersion,
} from "./muted-ips"
import { mutedIpsQueryOptions, queryKeys, useAddMutedIp } from "./queries"

function entry(network: string): MutedIpView {
  return { id: network, network, note: null, createdAt: "2026-11-20T10:00:00Z" }
}

function conflict() {
  const config = { headers: new AxiosHeaders() }
  return new AxiosError(
    "conflict",
    "ERR_BAD_REQUEST",
    config,
    {},
    {
      status: 409,
      statusText: "Conflict",
      data: {},
      headers: {},
      config,
    },
  )
}

let queryClient: QueryClient
const unsubscribers: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  resetMutedIpsStoreForTests()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.queryClient = queryClient
  mocks.fetchMutedIps.mockReset()
  mocks.addMutedIp.mockReset()
})

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  queryClient.clear()
  vi.unstubAllGlobals()
})

it("keeps the list forever once it has no observers", () => {
  expect(mutedIpsQueryOptions.gcTime).toBe(Infinity)
  expect(mutedIpsQueryOptions.queryKey).toEqual(["muted-ips"])
})

it("does not fetch for a passive observer that mounts on cached data", async () => {
  queryClient.setQueryData(queryKeys.mutedIps, [entry("1.2.3.4/32")])
  const observer = new QueryObserver(queryClient, {
    ...mutedIpsQueryOptions,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  })
  unsubscribers.push(observer.subscribe(() => {}))
  await Promise.resolve()
  expect(mocks.fetchMutedIps).not.toHaveBeenCalled()
})

it("confirms the version from the list a GET returns", async () => {
  mocks.fetchMutedIps.mockResolvedValue([entry("1.2.3.4/32")])
  await queryClient.fetchQuery(mutedIpsQueryOptions)
  expect(resolveVersion(getVersionStore())).toBe(listVersion(["1.2.3.4/32"]))
})

it("takes an unknown version when the first load fails", async () => {
  mocks.fetchMutedIps.mockRejectedValue(new Error("down"))
  await queryClient.fetchQuery(mutedIpsQueryOptions).catch(() => {})
  expect(resolveVersion(getVersionStore())).toMatch(/^unknown-/)
})

it("marks the list unconfirmed and refetches after a 409", async () => {
  mocks.fetchMutedIps.mockResolvedValue([entry("1.2.3.4/32")])
  await queryClient.fetchQuery(mutedIpsQueryOptions)
  mocks.fetchMutedIps.mockClear()
  mocks.addMutedIp.mockRejectedValue(conflict())
  useAddMutedIp()
  const observer = new MutationObserver(
    queryClient,
    mocks.mutationOptions as ConstructorParameters<typeof MutationObserver>[1],
  )
  await observer.mutate({ network: "1.2.3.4" }).catch(() => {})
  expect(mocks.fetchMutedIps).toHaveBeenCalledTimes(1)
  expect(resolveVersion(getVersionStore())).toBe(listVersion(["1.2.3.4/32"]))
})

it("does not refetch after an error that says nothing about the list", async () => {
  mocks.addMutedIp.mockRejectedValue(new Error("network down"))
  useAddMutedIp()
  const observer = new MutationObserver(
    queryClient,
    mocks.mutationOptions as ConstructorParameters<typeof MutationObserver>[1],
  )
  await observer.mutate({ network: "1.2.3.4" }).catch(() => {})
  expect(mocks.fetchMutedIps).not.toHaveBeenCalled()
  expect(getVersionStore().unconfirmed).toBe(false)
})

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
import { MutationObserver } from "@tanstack/react-query"
import {
  getVersionStore,
  resetMutedIpsStoreForTests,
  resolveVersion,
  listVersion,
} from "./muted-ips"
import {
  mutedIpsPassiveQueryOptions,
  mutedIpsQueryOptions,
  queryKeys,
  useAddMutedIp,
  useRemoveMutedIp,
} from "./queries"

function entry(network: string): MutedIpView {
  return { id: network, network, note: null, createdAt: "2026-11-20T10:00:00Z" }
}

function envelope(statusCode: number, code: string) {
  return { status_code: statusCode, detail: "changed elsewhere", code }
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

it("never fetches for a passive observer, with an empty, failed or seeded cache", async () => {
  const observe = () => {
    const observer = new QueryObserver(queryClient, mutedIpsPassiveQueryOptions)
    unsubscribers.push(observer.subscribe(() => {}))
  }
  observe()
  await Promise.resolve()
  expect(mocks.fetchMutedIps).not.toHaveBeenCalled()

  mocks.fetchMutedIps.mockRejectedValue(new Error("down"))
  await queryClient.fetchQuery(mutedIpsQueryOptions).catch(() => {})
  mocks.fetchMutedIps.mockClear()
  observe()
  await Promise.resolve()
  expect(mocks.fetchMutedIps).not.toHaveBeenCalled()

  queryClient.setQueryData(queryKeys.mutedIps, [entry("1.2.3.4/32")])
  observe()
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

function mutationFor(hook: () => void) {
  hook()
  return new MutationObserver(
    queryClient,
    mocks.mutationOptions as ConstructorParameters<typeof MutationObserver>[1],
  )
}

async function expectWriteSettlesList(
  hook: () => void,
  rejectWith: () => void,
  variables: string | { network: string },
) {
  mocks.fetchMutedIps.mockResolvedValue([entry("1.2.3.4/32")])
  await queryClient.fetchQuery(mutedIpsQueryOptions)
  mocks.fetchMutedIps.mockClear()
  rejectWith()
  let releaseRefetch: (entries: MutedIpView[]) => void = () => {}
  mocks.fetchMutedIps.mockImplementation(
    () => new Promise<MutedIpView[]>((resolve) => (releaseRefetch = resolve)),
  )
  const settled = mutationFor(hook)
    .mutate(variables as never)
    .catch(() => {})
  await vi.waitFor(() => expect(mocks.fetchMutedIps).toHaveBeenCalledTimes(1))
  expect(resolveVersion(getVersionStore())).toMatch(/^unknown-/)
  releaseRefetch([])
  await settled
  expect(resolveVersion(getVersionStore())).toBe("empty")
}

it("marks the list unconfirmed and refetches after a 409", async () => {
  await expectWriteSettlesList(
    useAddMutedIp,
    () => mocks.addMutedIp.mockRejectedValue(envelope(409, "muted_ip_exists")),
    { network: "1.2.3.4" },
  )
})

it("marks the list unconfirmed and refetches after a 404 on remove", async () => {
  await expectWriteSettlesList(
    useRemoveMutedIp,
    () => mocks.removeMutedIp.mockRejectedValue(envelope(404, "not_found")),
    "entry-id",
  )
})

it("does not refetch after an error that says nothing about the list", async () => {
  mocks.addMutedIp.mockRejectedValue(new Error("network down"))
  await mutationFor(useAddMutedIp)
    .mutate({ network: "1.2.3.4" })
    .catch(() => {})
  expect(mocks.fetchMutedIps).not.toHaveBeenCalled()
  expect(getVersionStore().unconfirmed).toBe(false)
})

import { beforeEach, expect, it, vi } from "vitest"
type QueryOptions = {
  queryKey: readonly unknown[]
  refetchInterval: number
  refetchOnWindowFocus: boolean
}
const mocks = vi.hoisted(() => ({ options: [] as QueryOptions[] }))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: (options: QueryOptions) => {
    mocks.options.push(options)
    return { data: options.queryKey[1] === "status" ? { enabled: true } : undefined }
  },
}))
import { DROP_NETWORKS_REFETCH_MS, useDropNetworks } from "./queries"

beforeEach(() => {
  mocks.options = []
})

it("polls the DROP traffic every five minutes and on window focus", () => {
  useDropNetworks({ days: 90, page: 1, pageSize: 25 })
  const dropNetworksOptions = mocks.options.find((options) => options.queryKey[1] === "drop-networks")!
  expect(DROP_NETWORKS_REFETCH_MS).toBe(5 * 60_000)
  expect(dropNetworksOptions.refetchInterval).toBe(DROP_NETWORKS_REFETCH_MS)
  expect(dropNetworksOptions.refetchOnWindowFocus).toBe(true)
  expect(dropNetworksOptions.queryKey[0]).toBe("crowdsec")
})

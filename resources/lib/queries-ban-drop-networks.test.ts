import { beforeEach, expect, it, vi } from "vitest"
import type { MutationObserverOptions } from "@tanstack/react-query"
import type { BanNetworksRequest, BanNetworksResponse } from "@/generated/api/types.gen"

type BanMutationOptions = MutationObserverOptions<BanNetworksResponse, Error, BanNetworksRequest>
const mocks = vi.hoisted(() => ({
  options: undefined as unknown,
  queryClient: undefined as unknown,
  post: vi.fn(),
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: (options: unknown) => {
    mocks.options = options
  },
  useQueryClient: () => mocks.queryClient,
}))
import { MutationObserver, QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { useBanDropNetworks } from "./queries"

const request: BanNetworksRequest = { allUnbannedDays: 30, duration: "4h" }
const response: BanNetworksResponse = {
  results: [{ network: "45.148.10.0/24", ok: false, error: "CrowdSec LAPI is unreachable", alreadyBanned: false }],
  leftOut: 0,
}

let queryClient: QueryClient
let invalidate: ReturnType<typeof vi.spyOn>

function banObserver() {
  useBanDropNetworks()
  return new MutationObserver(queryClient, mocks.options as BanMutationOptions)
}

beforeEach(() => {
  queryClient = new QueryClient()
  mocks.queryClient = queryClient
  // A refetch that never answers, like one stuck on a down LAPI.
  invalidate = vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(new Promise<void>(() => {}))
  mocks.post.mockReset()
  vi.spyOn(api, "post").mockImplementation(mocks.post)
})

it("hands back the results without waiting for the CrowdSec refresh", async () => {
  mocks.post.mockResolvedValue({ data: response })
  await expect(banObserver().mutate(request)).resolves.toEqual(response)
  expect(mocks.post).toHaveBeenCalledWith("/crowdsec/ban-networks", request)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["crowdsec"] })
})

it("refreshes CrowdSec queries after a failed run, since some bans may have gone through", async () => {
  mocks.post.mockRejectedValue(new Error("500"))
  await expect(banObserver().mutate(request)).rejects.toThrow("500")
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["crowdsec"] })
})

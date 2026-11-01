import { beforeEach, expect, it, vi } from "vitest"
import type { BannedRangeView } from "@/generated/api/types.gen"
type QueryOptions = {
  queryKey: readonly unknown[]
  queryFn: () => Promise<unknown>
  enabled: boolean
  select: (bannedRanges: BannedRangeView[]) => Map<string, BannedRangeView>
}
const mocks = vi.hoisted(() => ({
  options: [] as QueryOptions[],
  status: { enabled: true } as { enabled: boolean } | undefined,
  get: vi.fn(),
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    mocks.options.push(options)
    return { data: options.queryKey[1] === "status" ? mocks.status : undefined }
  },
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}))
import { api } from "./api"
import { useBannedRanges } from "./queries"

const bannedRangesOptions = () => mocks.options.filter((options) => options.queryKey[1] === "banned-ranges").at(-1)!

beforeEach(() => {
  mocks.options = []
  mocks.status = { enabled: true }
  mocks.get.mockReset()
  vi.spyOn(api, "get").mockImplementation(mocks.get)
})

it("sits in the crowdsec group so a ban or unban refreshes it", async () => {
  mocks.get.mockResolvedValue({ data: [] })
  useBannedRanges()
  expect(bannedRangesOptions().queryKey).toEqual(["crowdsec", "banned-ranges"])
  await bannedRangesOptions().queryFn()
  expect(mocks.get).toHaveBeenCalledWith("/crowdsec/banned-ranges")
})

it("asks only while active with CrowdSec enabled", () => {
  useBannedRanges()
  expect(bannedRangesOptions().enabled).toBe(true)
  useBannedRanges(false)
  expect(bannedRangesOptions().enabled).toBe(false)
  for (const status of [undefined, { enabled: false }]) {
    mocks.status = status
    useBannedRanges()
    expect(bannedRangesOptions().enabled).toBe(false)
  }
})

it("looks ranges up by their exact CIDR", () => {
  useBannedRanges()
  const bannedRange: BannedRangeView = { value: "192.0.2.0/24", type: "ban", expiresAt: "2026-11-01T10:00:00Z" }
  const bannedRanges = bannedRangesOptions().select([bannedRange])
  expect(bannedRanges.get("192.0.2.0/24")).toEqual(bannedRange)
  expect(bannedRanges.has("192.0.2.0/25")).toBe(false)
})

import { expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  options: [] as Array<{ queryKey: unknown[]; staleTime: unknown; refetchOnWindowFocus: unknown }>,
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof mocks.options[number]) => {
    mocks.options.push(options)
    return { data: undefined }
  },
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}))
import { ABOUT_STALE_MS, useAbout } from "./queries"

it("refetches About after five minutes and on window focus, so the DROP state does not freeze", () => {
  useAbout()
  const options = mocks.options.at(-1)!
  expect(options.staleTime).toBe(ABOUT_STALE_MS)
  expect(ABOUT_STALE_MS).toBe(5 * 60_000)
  expect(options.refetchOnWindowFocus).toBe(true)
})

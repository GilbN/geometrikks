import { beforeEach, expect, it, vi } from "vitest"
import type { MutationObserverOptions } from "@tanstack/react-query"
import type { CreateApiKeyPayload, CreatedApiKey } from "@/generated/api/types.gen"

type CreateMutationOptions = MutationObserverOptions<CreatedApiKey, Error, CreateApiKeyPayload>
const mocks = vi.hoisted(() => ({
  options: undefined as unknown,
  queryClient: undefined as unknown,
  createApiKey: vi.fn(),
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: (options: unknown) => {
    mocks.options = options
  },
  useQueryClient: () => mocks.queryClient,
}))
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  createApiKey: mocks.createApiKey,
}))
import { MutationObserver, QueryClient } from "@tanstack/react-query"
import { useCreateApiKey } from "./queries"

const SECRET = "gmk_7Hq2vN0cLw8RkYbT3sE5uJmA1pXdZgFh6oQiWe4tByC"
const created: CreatedApiKey = {
  key: SECRET,
  apiKey: {
    id: "6f1c1f9e-6c1d-4a59-9a1f-0c8f6f2d1a11",
    name: "homepage",
    scope: "read",
    displayPrefix: "gmk_7Hq2",
    createdAt: "2026-11-02T10:00:00Z",
    createdBy: "admin",
    expiresAt: null,
    expired: false,
    lastUsedAt: null,
    lastUsedIp: null,
  },
}

let queryClient: QueryClient

function createObserver() {
  useCreateApiKey()
  return new MutationObserver(queryClient, mocks.options as CreateMutationOptions)
}

function cachedText(): string {
  return JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state))
}

beforeEach(() => {
  queryClient = new QueryClient()
  mocks.queryClient = queryClient
  vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
  mocks.createApiKey.mockReset()
})

it("drops the created key from the mutation cache once the caller resets", async () => {
  mocks.createApiKey.mockResolvedValue(created)
  const observer = createObserver()
  await expect(observer.mutate({ name: "homepage" })).resolves.toEqual(created)
  expect(cachedText()).toContain(SECRET)

  observer.reset()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cachedText()).not.toContain(SECRET)
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0)
})

it("does not keep a finished create around for the default five minutes", () => {
  createObserver()
  expect((mocks.options as CreateMutationOptions).gcTime).toBe(0)
})

it("tags the create so a host can tell it is still running", () => {
  createObserver()
  expect((mocks.options as CreateMutationOptions).mutationKey).toEqual(["auth", "api-keys", "create"])
})

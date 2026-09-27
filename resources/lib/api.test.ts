import { afterEach, describe, expect, it, vi } from "vitest"
import { api, fetchCrowdsecAlerts } from "./api"

afterEach(() => vi.restoreAllMocks())

function sentParams(get: ReturnType<typeof vi.spyOn>, call: number): Record<string, unknown> {
  const config = get.mock.calls[call][1] as { params: Record<string, unknown> }
  return config.params
}

describe("fetchCrowdsecAlerts", () => {
  it("sends hasActiveDecision as given: true, false, or not at all", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: [] })
    await fetchCrowdsecAlerts({ hasActiveDecision: true })
    await fetchCrowdsecAlerts({ hasActiveDecision: false })
    await fetchCrowdsecAlerts({})
    expect(sentParams(get, 0).hasActiveDecision).toBe(true)
    expect(sentParams(get, 1).hasActiveDecision).toBe(false)
    expect(sentParams(get, 2).hasActiveDecision).toBeUndefined()
  })

  it("only sends a kind when one is chosen", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: [] })
    await fetchCrowdsecAlerts({ kind: "bot-detection" })
    await fetchCrowdsecAlerts({})
    expect(sentParams(get, 0).kind).toBe("bot-detection")
    expect(sentParams(get, 1).kind).toBeUndefined()
  })
})

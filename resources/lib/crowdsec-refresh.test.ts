import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { describe, expect, it } from "vite-plus/test"
import { refreshCrowdsecAfterWrite } from "./crowdsec-refresh"

describe("refreshCrowdsecAfterWrite", () => {
  it("waits for the stats but not for alerts per day", async () => {
    const queryClient = new QueryClient()
    let statsFetches = 0
    const observers = [
      new QueryObserver(queryClient, {
        queryKey: ["crowdsec", "stats"],
        queryFn: () => ++statsFetches,
      }),
      new QueryObserver(queryClient, {
        queryKey: ["crowdsec", "alerts-per-day", 7],
        queryFn: () => new Promise<number>(() => {}),
      }),
    ]
    const unsubscribers = observers.map((observer) => observer.subscribe(() => {}))
    await queryClient.refetchQueries({ queryKey: ["crowdsec", "stats"] })

    await refreshCrowdsecAfterWrite(queryClient)

    expect(statsFetches).toBe(2)
    expect(queryClient.isFetching({ queryKey: ["crowdsec", "alerts-per-day"] })).toBe(1)
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    queryClient.clear()
  })
})

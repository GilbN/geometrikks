import { describe, expect, it } from "vitest"
import { myIpExclusion, toggleWithFreshIp } from "./my-ip-exclusion"

const MY_IP = "2001:db8:4f1::1a"

function harness(clientIp: Parameters<typeof myIpExclusion>[0], initial: string[] = []) {
  let excludedIps = [...initial]
  const current = () =>
    myIpExclusion(
      clientIp,
      excludedIps,
      (ip) => { excludedIps = [...excludedIps, ip] },
      (ip) => { excludedIps = excludedIps.filter((value) => value !== ip) },
    )
  return { current, excludedIps: () => excludedIps }
}

describe("myIpExclusion", () => {
  it("has no address while the lookup is loading", () => {
    const exclusion = harness(undefined).current()
    expect(exclusion.ip).toBeNull()
    expect(exclusion.behindUntrustedProxy).toBe(false)
  })

  it("hides the proxy's address when the server is behind an untrusted proxy", () => {
    const exclusion = harness({ ip: "172.18.0.2", behindUntrustedProxy: true }).current()
    expect(exclusion.ip).toBeNull()
    expect(exclusion.behindUntrustedProxy).toBe(true)
  })

  it("adds the current address next to ones excluded earlier", () => {
    const h = harness({ ip: MY_IP, behindUntrustedProxy: false }, ["2001:db8:4f1::9c"])
    expect(h.current().excluded).toBe(false)
    h.current().toggle()
    expect(h.excludedIps()).toEqual(["2001:db8:4f1::9c", MY_IP])
    expect(h.current().excluded).toBe(true)
  })

  it("removes the address as it was typed, whatever its case", () => {
    const h = harness({ ip: MY_IP, behindUntrustedProxy: false }, ["2001:DB8:4F1::1A", "198.51.100.23"])
    expect(h.current().excluded).toBe(true)
    h.current().toggle()
    expect(h.excludedIps()).toEqual(["198.51.100.23"])
  })

  it("matches the same address written out in full", () => {
    const h = harness({ ip: MY_IP, behindUntrustedProxy: false }, ["2001:0db8:04f1:0000:0000:0000:0000:001a"])
    expect(h.current().excluded).toBe(true)
    h.current().toggle()
    expect(h.excludedIps()).toEqual([])
  })
})

describe("toggleWithFreshIp", () => {
  const OLD_IP = "198.51.100.23"

  function tap(lookup: () => Promise<{ ip: string | null; behindUntrustedProxy: boolean }>, initial: string[], mounted = true) {
    let excludedIps = [...initial]
    const done = toggleWithFreshIp(
      lookup,
      () => mounted,
      () => excludedIps,
      (ip) => { excludedIps = [...excludedIps, ip] },
      (ip) => { excludedIps = excludedIps.filter((value) => value !== ip) },
    )
    return done.then(() => excludedIps)
  }

  it("adds the new address after a network change instead of removing the old one", async () => {
    const after = await tap(async () => ({ ip: MY_IP, behindUntrustedProxy: false }), [OLD_IP])
    expect(after).toEqual([OLD_IP, MY_IP])
  })

  it("leaves the exclusions alone when the lookup fails", async () => {
    const after = await tap(() => Promise.reject(new Error("offline")), [OLD_IP])
    expect(after).toEqual([OLD_IP])
  })

  it("acts on the excluded IPs as they are when the reply lands", async () => {
    let excludedIps: string[] = []
    let answer: (value: { ip: string; behindUntrustedProxy: boolean }) => void = () => {}
    const done = toggleWithFreshIp(
      () => new Promise((resolve) => { answer = resolve }),
      () => true,
      () => excludedIps,
      (ip) => { excludedIps = [...excludedIps, ip] },
      (ip) => { excludedIps = excludedIps.filter((value) => value !== ip) },
    )
    excludedIps = [MY_IP]
    answer({ ip: MY_IP, behindUntrustedProxy: false })
    await done
    expect(excludedIps).toEqual([])
  })

  it("drops a reply that arrives after the page is gone", async () => {
    const after = await tap(async () => ({ ip: MY_IP, behindUntrustedProxy: false }), [], false)
    expect(after).toEqual([])
  })
})

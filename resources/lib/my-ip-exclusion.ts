import type { ClientIpResponse } from "@/generated/api/types.gen"

export interface MyIpExclusion {
  /** Null while loading, when the server sees no address, or when it only sees an untrusted proxy. */
  ip: string | null
  behindUntrustedProxy: boolean
  excluded: boolean
  toggle: () => void
}

/** One spelling per address, so a typed `2001:0db8::1A` matches the server's `2001:db8::1a`. */
function addressKey(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.includes(":")) return trimmed
  try {
    return new URL(`http://[${trimmed}]`).hostname
  } catch {
    return trimmed
  }
}

export function myIpExclusion(
  clientIp: ClientIpResponse | undefined,
  excludedIps: string[],
  onAdd: (ip: string) => void,
  onRemove: (ip: string) => void,
): MyIpExclusion {
  const behindUntrustedProxy = clientIp?.behindUntrustedProxy ?? false
  const ip = behindUntrustedProxy ? null : (clientIp?.ip ?? null)
  const key = ip === null ? null : addressKey(ip)
  const match = key === null ? undefined : excludedIps.find((value) => addressKey(value) === key)
  return {
    ip,
    behindUntrustedProxy,
    excluded: match !== undefined,
    toggle: () => {
      if (ip === null) return
      if (match === undefined) onAdd(ip)
      else onRemove(match)
    },
  }
}

/**
 * Looks the address up again, then toggles it. A phone that moved from Wi-Fi
 * to 5G while the page stayed open still has the old address cached.
 * A failed lookup changes nothing, because toggling the old address could
 * remove an exclusion instead of adding one. Changing the filters navigates,
 * so a reply that lands after the user left the page is dropped. The reply
 * acts on the excluded IPs as they are when it lands, not as they were at the tap.
 */
export async function toggleWithFreshIp(
  lookup: () => Promise<ClientIpResponse>,
  stillMounted: () => boolean,
  currentExcludedIps: () => string[],
  onAdd: (ip: string) => void,
  onRemove: (ip: string) => void,
): Promise<void> {
  let fresh: ClientIpResponse
  try {
    fresh = await lookup()
  } catch {
    return
  }
  if (stillMounted()) myIpExclusion(fresh, currentExcludedIps(), onAdd, onRemove).toggle()
}

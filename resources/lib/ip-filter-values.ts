/**
 * What the IP include and exclude filters accept: an address, or a CIDR range
 * that starts on its network address, by the same rules the server applies to
 * the filters and to Muted IPs.
 */
import { isValidIp } from "@/lib/crowdsec"

function ipv6Groups(address: string): bigint[] {
  // The URL parser rewrites an embedded IPv4 tail as two hex groups.
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [head, tail] = host.split("::")
  const headGroups = head ? head.split(":") : []
  const tailGroups = tail === undefined ? [] : tail ? tail.split(":") : []
  const missing = 8 - headGroups.length - tailGroups.length
  return [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups].map((group) =>
    BigInt(`0x${group}`),
  )
}

function toBigInt(address: string): bigint {
  if (!address.includes(":"))
    return address.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n)
  return ipv6Groups(address).reduce((acc, group) => (acc << 16n) | group, 0n)
}

function formatIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(16 * (7 - index))) & 0xffffn),
  )
  let bestStart = -1
  let bestLength = 1
  for (let start = 0; start < 8; start++) {
    let length = 0
    while (start + length < 8 && groups[start + length] === 0) length++
    if (length > bestLength) {
      bestStart = start
      bestLength = length
    }
  }
  const hex = groups.map((group) => group.toString(16))
  if (bestStart === -1) return hex.join(":")
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`
}

function fromBigInt(value: bigint, bits: number): string {
  if (bits === 128) return formatIpv6(value)
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".")
}

interface ParsedRange {
  start: string
  hostBitsSet: boolean
}

const MAPPED_PREFIX = 96
const MAPPED_BASE = 0xffffn << 32n

/** Shown the way the server names it: an IPv4-mapped range of /96 or longer as IPv4. */
function formatStart(start: bigint, prefix: number, bits: number): string {
  if (bits === 128 && prefix >= MAPPED_PREFIX && start >> 32n === 0xffffn)
    return `${fromBigInt(start - MAPPED_BASE, 32)}/${prefix - MAPPED_PREFIX}`
  return `${fromBigInt(start, bits)}/${prefix}`
}

function parseRange(value: string): ParsedRange | null {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(value)
  if (!match || !isValidIp(match[1])) return null
  const bits = match[1].includes(":") ? 128 : 32
  const prefix = Number(match[2])
  if (prefix > bits) return null
  const address = toBigInt(match[1])
  const hostMask = (1n << BigInt(bits - prefix)) - 1n
  return {
    start: formatStart(address & ~hostMask, prefix, bits),
    hostBitsSet: (address & hostMask) !== 0n,
  }
}

export function isValidIpFilter(value: string): boolean {
  if (isValidIp(value)) return true
  const range = parseRange(value)
  return range !== null && !range.hostBitsSet
}

/** "Use 203.0.113.0/24" for a range with host bits set, null otherwise. */
export function ipFilterHint(value: string): string | null {
  const range = parseRange(value)
  return range?.hostBitsSet ? `Use ${range.start}` : null
}

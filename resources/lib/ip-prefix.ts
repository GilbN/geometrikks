/**
 * Turns an IP address typed in the command palette, whole or in part, into
 * the CIDR ranges that hold every address starting with it. The IP filters
 * take ranges, so "203.0.11" becomes 203.0.11.0/24, 203.0.110.0/23 and
 * 203.0.112.0/21, and the server never needs a prefix search of its own.
 *
 * A search starts once the first IPv4 octet or IPv6 group is complete and
 * followed by its separator. A single digit would match a tenth of the
 * address space, which is slow to count over everything kept.
 */

export interface IpQuery {
  /** What the user typed, trimmed. Results highlight this part. */
  typed: string
  /** CIDR ranges covering every address that starts with the typed text. */
  ranges: string[]
  /** The typed text as one range when it is one, such as 198.51.0.0/16 for "198.51". */
  cidr: string | null
  /** The typed text as a whole address, when it is one. */
  address: string | null
}

const IPV4_TEXT = /^\d{1,3}(\.\d{0,3}){1,3}$/
const IPV6_TEXT = /^[0-9a-f]{1,4}(:[0-9a-f]{0,4}){1,7}$/i

export function parseIpQuery(text: string): IpQuery | null {
  const typed = text.trim()
  if (IPV4_TEXT.test(typed)) return ipv4Query(typed)
  if (typed.includes("::")) return fullIpv6(typed)
  if (IPV6_TEXT.test(typed)) return ipv6Query(typed)
  return null
}

function octet(part: string): number | null {
  if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null
  const value = Number(part)
  return value <= 255 ? value : null
}

/** The octet values that start with `digits`. For "1" that is 1, 10 to 19 and 100 to 199. */
function octetsStartingWith(digits: string): number[] {
  if (digits === "0") return [0]
  if (digits.startsWith("0")) return []
  const values: number[] = []
  for (let extra = 0; digits.length + extra <= 3; extra++) {
    const low = Number(digits) * 10 ** extra
    for (let value = low; value < low + 10 ** extra && value <= 255; value++) values.push(value)
  }
  return values
}

function ipv4Query(typed: string): IpQuery | null {
  const parts = typed.split(".")
  const last = parts.pop() ?? ""
  const whole = parts.map(octet)
  if (whole.some((value) => value === null)) return null
  const fixed = whole as number[]
  const base = fixed.reduce((sum, value, index) => sum + value * 256 ** (3 - index), 0)
  const shift = 256 ** (3 - fixed.length)

  if (last === "") {
    const cidr = `${ipv4(base)}/${8 * fixed.length}`
    return { typed, ranges: [cidr], cidr, address: null }
  }
  const values = octetsStartingWith(last)
  if (values.length === 0) return null
  const ranges = mergeRuns(values).flatMap(([low, high]) =>
    ipv4Cidrs(base + low * shift, base + (high + 1) * shift - 1),
  )
  const address = fixed.length === 3 && octet(last) !== null ? typed : null
  return { typed, ranges, cidr: ranges.length === 1 && !address ? ranges[0] : null, address }
}

/** Consecutive values as [low, high] runs. */
function mergeRuns(values: number[]): [number, number][] {
  const runs: [number, number][] = []
  for (const value of [...values].sort((a, b) => a - b)) {
    const run = runs.at(-1)
    if (run && value === run[1] + 1) run[1] = value
    else runs.push([value, value])
  }
  return runs
}

function ipv4(value: number): string {
  return [24, 16, 8, 0].map((bits) => Math.floor(value / 2 ** bits) % 256).join(".")
}

/** The fewest CIDR blocks that cover start to end. */
function ipv4Cidrs(start: number, end: number): string[] {
  const blocks: string[] = []
  let at = start
  while (at <= end) {
    let size = 1
    while (at % (size * 2) === 0 && at + size * 2 - 1 <= end) size *= 2
    blocks.push(`${ipv4(at)}/${32 - Math.log2(size)}`)
    at += size
  }
  return blocks
}

function ipv6(groups: number[]): string {
  return groups.map((group) => group.toString(16)).join(":")
}

function ipv6Query(typed: string): IpQuery | null {
  const parts = typed.toLowerCase().split(":")
  const last = parts.pop() ?? ""
  if (parts.some((part) => part === "")) return null
  const fixed = parts.map((part) => parseInt(part, 16))
  const pad = (groups: number[]) => [...groups, ...Array(8 - groups.length).fill(0)]

  if (last === "") {
    const cidr = `${ipv6(pad(fixed))}/${16 * fixed.length}`
    return { typed, ranges: [cidr], cidr, address: null }
  }
  const value = parseInt(last, 16)
  if (fixed.length === 7) {
    const address = ipv6([...fixed, value])
    return last.length === 4
      ? { typed, ranges: [`${address}/128`], cidr: null, address }
      : { typed, ranges: groupBlocks(fixed, last, pad), cidr: null, address }
  }
  const ranges = groupBlocks(fixed, last, pad)
  return { typed, ranges, cidr: ranges.length === 1 ? ranges[0] : null, address: null }
}

/**
 * The blocks for a group typed in part. "a" stands for a, a0 to af, a00 to
 * aff and a000 to afff, each an aligned block of group values.
 */
function groupBlocks(
  fixed: number[],
  digits: string,
  pad: (groups: number[]) => number[],
): string[] {
  const value = parseInt(digits, 16)
  const blocks: string[] = []
  for (let extra = 4 - digits.length; extra >= 0; extra--) {
    // A leading zero adds nothing new. 0 to fff already holds 0 to ff.
    if (value === 0 && extra < 4 - digits.length) break
    const groupValue = value * 16 ** extra
    blocks.push(`${ipv6(pad([...fixed, groupValue]))}/${16 * fixed.length + 16 - 4 * extra}`)
  }
  return blocks
}

/** A whole IPv6 address written with "::". It matches only itself. */
function fullIpv6(typed: string): IpQuery | null {
  try {
    const host = new URL(`http://[${typed}]/`).hostname.slice(1, -1)
    return { typed, ranges: [`${host}/128`], cidr: null, address: host }
  } catch {
    return null
  }
}

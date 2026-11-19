import { isValidIp } from "@/lib/crowdsec"

/** One IPv4 or IPv6 address in canonical form (IPv6 lowercased and
 *  compressed, IPv4-mapped with a dotted tail as the server prints it), or
 *  null. Ranges are not addresses here. */
export function parseSingleIp(text: string): string | null {
  const value = text.trim()
  if (!isValidIp(value)) return null
  if (!value.includes(":")) return value
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return `::ffff:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

import { isValidIp } from "@/lib/crowdsec"

/** One IPv4 or IPv6 address in canonical form (IPv6 lowercased and
 *  compressed), or null. Ranges are not addresses here. */
export function parseSingleIp(text: string): string | null {
  const value = text.trim()
  if (!isValidIp(value)) return null
  if (!value.includes(":")) return value
  return new URL(`http://[${value}]/`).hostname.slice(1, -1)
}

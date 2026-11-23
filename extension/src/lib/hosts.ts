/** The host values a tab's URL can appear under in the access logs, or null
 *  for a page that isn't http(s). Caddy logs IPv6 hosts without brackets,
 *  so an IPv6 literal goes in both ways. */
export function hostValuesFromUrl(url: string | undefined): string[] | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  const { hostname, port } = parsed
  if (!hostname) return null
  const values = [hostname]
  if (hostname.startsWith("[")) values.push(hostname.slice(1, -1))
  if (port) values.push(`${hostname}:${port}`)
  return values
}

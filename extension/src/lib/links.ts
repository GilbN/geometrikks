export function inspectorUrl(origin: string, ip: string): string {
  return `${origin}/?inspect=${encodeURIComponent(ip)}`
}

/** The app's router reads `host` as a JSON string array; a bare string is dropped. */
export function analyticsUrl(origin: string, hosts: string[]): string {
  return `${origin}/analytics?host=${encodeURIComponent(JSON.stringify(hosts))}`
}

export function inspectorUrl(origin: string, ip: string): string {
  return `${origin}/?inspect=${encodeURIComponent(ip)}`
}

/** The app's router reads `host` as a JSON string array; a bare string is dropped. */
export function accessLogsUrl(origin: string, hosts: string[]): string {
  return `${origin}/access-logs?host=${encodeURIComponent(JSON.stringify(hosts))}`
}

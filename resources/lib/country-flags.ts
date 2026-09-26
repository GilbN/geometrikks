// no-inline keeps each flag a separate file; Vite would otherwise base64
// every flag under 4 KB into the bundle, since the glob references them all.
const FLAG_URLS = import.meta.glob<string>("/node_modules/flag-icons/flags/4x3/*.svg", {
  query: "?url&no-inline",
  import: "default",
  eager: true,
})

const flagsByCode = new Map(
  Object.entries(FLAG_URLS).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4), url]),
)

const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" })

function normalize(code: string | null | undefined): string | undefined {
  const value = code?.trim().toUpperCase()
  return value && /^[A-Z]{2}$/.test(value) ? value : undefined
}

export function flagUrl(code: string | null | undefined): string | undefined {
  const value = normalize(code)
  return value ? flagsByCode.get(value.toLowerCase()) : undefined
}

export function countryDisplayName(code: string | null | undefined): string | undefined {
  const value = normalize(code)
  return value ? regionNames.of(value) : undefined
}

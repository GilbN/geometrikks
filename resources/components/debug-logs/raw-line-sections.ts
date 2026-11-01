import type { RawLineField, RawLineFields } from "@/lib/api"

export interface RawLineSection {
  title: string
  fields: RawLineField[]
}

const HEADER_SECTIONS: { group: RawLineField["group"]; title: string }[] = [
  { group: "request_header", title: "Request headers" },
  { group: "response_header", title: "Response headers" },
  { group: "origin_header", title: "Origin response headers" },
]

/** Headers first, then the keys GeoMetrikks drops, then the ones it keeps.
 * Without a format nothing is known to be stored, so the rest stays one list. */
export function rawLineSections(rawFields: RawLineFields): RawLineSection[] {
  const plain = rawFields.fields.filter((f) => f.group === "field")
  const sections: RawLineSection[] = [
    ...HEADER_SECTIONS.map(({ group, title }) => ({
      title,
      fields: rawFields.fields.filter((f) => f.group === group),
    })),
    ...(rawFields.format === null
      ? [{ title: "Fields", fields: plain }]
      : [
          { title: "Not stored", fields: plain.filter((f) => !f.storedAs) },
          { title: "Stored in the access log", fields: plain.filter((f) => f.storedAs) },
        ]),
  ]
  return sections.filter((section) => section.fields.length > 0)
}

const VALUE_BREAKS = /(?<=[/:_=&?,;@])/
const KEY_BREAKS = /(?<=[./:_=&?,;@])|(?<=[a-z])(?=[A-Z])/

/** Word-sized pieces of a key or value, joined with <wbr> when rendered.
 * Without them a phone-width column splits DownstreamContentSize or
 * host:port at any letter. Values skip camel case and dots, which would split
 * AppleWebKit and 537.36. */
export function breakSegments(text: string, { key = false }: { key?: boolean } = {}): string[] {
  return text.split(key ? KEY_BREAKS : VALUE_BREAKS)
}

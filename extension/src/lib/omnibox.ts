/** Omnibox descriptions are XML; a raw "&" (an ASN like "AT&T") makes Chrome throw. */
export function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function firstToken(text: string): string {
  return text.trim().split(/\s+/)[0] ?? ""
}

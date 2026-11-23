export type NormalizedOrigin =
  | { ok: true; origin: string; pattern: string }
  | { ok: false; reason: "invalid" | "not-https" }

/** The server's origin, and the host permission pattern for it. The pattern
 *  names the port, because a pattern without one matches every port. */
export function normalizeOrigin(input: string): NormalizedOrigin {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { ok: false, reason: "invalid" }
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not-https" }
  if (!url.hostname || url.hostname.includes("*")) return { ok: false, reason: "invalid" }
  return {
    ok: true,
    origin: url.origin,
    pattern: `https://${url.hostname}:${url.port || "443"}/*`,
  }
}

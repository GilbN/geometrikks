import { isAxiosError } from "axios"

/** Human-readable message for a failed CrowdSec API call: the backend's
 * `detail` (e.g. "CrowdSec LAPI is unreachable") when present, else the
 * caller's fallback. */
export function crowdsecErrorMessage(err: unknown, fallback: string): string {
  const detail = isAxiosError(err)
    ? (err.response?.data as { detail?: string } | undefined)?.detail
    : null
  return detail ?? fallback
}

/** A 4xx answer, which a retry would only repeat. */
export function isClientError(err: unknown): boolean {
  const status = isAxiosError(err) ? err.response?.status : undefined
  return status !== undefined && status >= 400 && status < 500
}

import { normalizeOrigin } from "../lib/origin"
import type { StoredConnection } from "../lib/storage"

const KEY_PREFIX_LENGTH = 8
const KEY_MASK = "•".repeat(24)
export const EMPTY_KEY_PLACEHOLDER = "gmk_…"

/** The key Connect sends. A stored key only ever goes back to the origin it
 *  was saved for; any other origin gets just what was typed in this form. */
export function keyToSend(input: {
  typed: string
  storedKey: string | null
  storedOrigin: string | null
  submittedOrigin: string | null
}): string {
  const typed = input.typed.trim()
  if (typed) return typed
  const sameOrigin = input.submittedOrigin !== null && input.submittedOrigin === input.storedOrigin
  return sameOrigin && input.storedKey ? input.storedKey : ""
}

function submittedOrigin(address: string): string | null {
  const normalized = normalizeOrigin(address)
  return normalized.ok ? normalized.origin : null
}

/** What Connect sends for this form: key and origin come from the same
 *  stored connection, as last loaded in this tab. */
export function submission(
  form: { address: string; typed: string },
  stored: StoredConnection | null,
): { address: string; key: string; reusesStoredKey: boolean } {
  const key = keyToSend({
    typed: form.typed,
    storedKey: stored?.key ?? null,
    storedOrigin: stored?.origin ?? null,
    submittedOrigin: submittedOrigin(form.address),
  })
  return { address: form.address, key, reusesStoredKey: !form.typed.trim() && key !== "" }
}

/** The placeholder of the empty key field: the stored key, masked unless
 *  shown, while an empty field would reuse it. */
export function keyPlaceholder(
  form: { address: string; showKey: boolean },
  stored: StoredConnection | null,
): string {
  const reused = submission({ address: form.address, typed: "" }, stored)
  if (!reused.reusesStoredKey) return EMPTY_KEY_PLACEHOLDER
  return form.showKey ? reused.key : `${reused.key.slice(0, KEY_PREFIX_LENGTH)}${KEY_MASK}`
}

export const AUTH_OFF_WITH_STORED_KEY_MESSAGE =
  "Authentication is off on this server. Disconnect, then connect again with the key field empty."

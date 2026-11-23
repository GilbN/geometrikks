export type Failure =
  | "key-invalid"
  | "needs-key"
  | "keys-unavailable"
  | "unreachable"
  | "access-removed"

export interface FailureInput {
  status?: number
  code?: string
  /** The server's `detail`, shown as is. */
  detail?: string
  networkError?: boolean
  notJson?: boolean
  timedOut?: boolean
}

export function classifyFailure(
  input: FailureInput,
  ctx: { keyless: boolean; permissionMissing: boolean },
): Failure {
  if (ctx.permissionMissing) return "access-removed"
  if (input.networkError || input.timedOut || input.notJson) return "unreachable"
  switch (input.code) {
    case "api_key_invalid":
    case "api_key_expired":
      return "key-invalid"
    case "not_authenticated":
      return ctx.keyless ? "needs-key" : "unreachable"
    case "api_keys_unavailable":
      return "keys-unavailable"
    default:
      return "unreachable"
  }
}

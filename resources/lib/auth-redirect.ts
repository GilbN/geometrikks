/** Pure decision logic for the /login and /logout routes. Kept free of the
 *  router so every branch is unit-testable, and so the route modules own
 *  every throw: a redirect thrown from inside a try block would be swallowed
 *  by that block's own catch. */
import axios from "axios"
import type { MeResponse } from "@/lib/api"

export type MeResult =
  | { ok: true; me: MeResponse }
  /** status is null for a network failure, where there is no response. */
  | { ok: false; status: number | null; error: unknown }

export type AuthRoutePlan =
  | { action: "redirect"; to: "/" | "/login" }
  | { action: "endSessionThenRedirect"; to: "/login" }
  | { action: "render" }
  /** Carries the original throw so the error boundary sees its real message
   *  and stack, and so the route has nothing left to remember. */
  | { action: "rethrow"; error: unknown }

/** Classify whatever fetchMe() threw, keeping the error itself alongside the
 *  status it was classified by. */
export function toMeResult(error: unknown): MeResult {
  // isAxiosError, not a structural cast: any object with a response.status
  // would otherwise be read as an HTTP failure.
  if (!axios.isAxiosError(error)) return { ok: false, status: null, error }
  return { ok: false, status: error.response?.status ?? null, error }
}

export function planLoginRoute(result: MeResult): AuthRoutePlan {
  if (result.ok) {
    // Disabled: nothing to log into. Session: already logged in.
    return { action: "redirect", to: "/" }
  }
  // 401 is the ordinary "auth is on and nobody is logged in yet" case.
  // Anything else means the API is broken, and a form that will fail on
  // submit with "Invalid username or password" would be a lie.
  return result.status === 401
    ? { action: "render" }
    : { action: "rethrow", error: result.error }
}

export function planLogoutRoute(result: MeResult): AuthRoutePlan {
  if (result.ok) {
    return result.me.mode === "session"
      ? { action: "endSessionThenRedirect", to: "/login" }
      : { action: "redirect", to: "/" }
  }
  return result.status === 401
    ? { action: "redirect", to: "/login" }
    : { action: "rethrow", error: result.error }
}

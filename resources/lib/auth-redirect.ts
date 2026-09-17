/** Pure decision logic for the /login and /logout routes. Kept free of the
 *  router so every branch is unit-testable, and so the route modules own
 *  every throw: a redirect thrown from inside a try block would be swallowed
 *  by that block's own catch. */
import axios from "axios"
import type { AuthOptions, MeResponse } from "@/lib/api"

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

/** Routes that render without the app chrome (sidebar, providers, etc). */
const CHROMELESS_ROUTES = new Set(["/login", "/signed-out"])

/** True for a route the root layout must render bare, with no sidebar or
 *  data providers mounted. /login has nothing to protect. /signed-out needs
 *  the same treatment for a different reason: its protected requests would
 *  401 the moment the chrome mounted, and the global redirect that follows
 *  would send the visitor straight to /login, whose single SSO button would
 *  sign them back in immediately, undoing the sign-out they just asked for. */
export function isChromelessRoute(pathname: string): boolean {
  return CHROMELESS_ROUTES.has(pathname)
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

/** Fixed sentences for the fixed codes the callback puts in the URL. The
 *  IdP's own error text never reaches the browser, so nothing here is
 *  interpolated. */
export const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  oidc_denied: "Sign-in was cancelled or refused by the identity provider.",
  oidc_forbidden: "Your account is not allowed to use this app. Check the allowed users and groups.",
  oidc_failed: "Sign-in could not be completed. Try again.",
  oidc_unavailable: "The identity provider could not be reached. Try again in a moment.",
}

export type LoginFormPlan = {
  oidc: { providerName: string } | null
  password: boolean
  message: string | null
  description: string
}

export function planLoginForm(options: AuthOptions, errorCode: string | null): LoginFormPlan {
  const oidc = options.oidc ? { providerName: options.oidc.providerName } : null
  const password = options.password
  const description =
    oidc && password
      ? "Sign in to continue."
      : oidc
        ? `Sign in with your ${oidc.providerName} account.`
        : "Enter the administrator credentials configured for this installation."
  const message =
    errorCode && Object.hasOwn(LOGIN_ERROR_MESSAGES, errorCode) ? LOGIN_ERROR_MESSAGES[errorCode] : null
  return { oidc, password, message, description }
}

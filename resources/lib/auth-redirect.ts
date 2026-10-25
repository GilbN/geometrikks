/** Pure decision logic for the /login and /logout routes. Kept free of the
 *  router so every branch is unit-testable, and so the route modules own
 *  every throw: a redirect thrown from inside a try block would be swallowed
 *  by that block's own catch. */
import axios from "axios"
import type { AxiosRequestConfig } from "axios"
import type { AuthOptions, HealthResponse, LogoutResponse, MeResponse } from "@/lib/api"

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

const CHROMELESS_ROUTES = new Set(["/login", "/signed-out"])

/** Routes the root layout renders without the sidebar or data providers.
 *  /login has no session yet. /signed-out must not mount the chrome either:
 *  its protected requests would 401 and the global redirect would land on
 *  /login, where a lone SSO button signs the visitor straight back in. */
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

/** What the login form says when POST /auth/login fails. A 503 is the session
 *  store being down, not a wrong password, so it must not read like one. */
export function loginErrorMessage(error: unknown): string {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined
  if (status === 401) return "Invalid username or password"
  if (status === 503) {
    return "The database is unavailable, so nobody can sign in right now. Try again in a minute."
  }
  return "Sign-in failed. Try again."
}

/** Navigates only once the server has ended the session. Navigating on a
 *  failed logout would look signed out while the session cookie stays live. */
export async function logoutThenNavigate(
  doLogout: () => Promise<LogoutResponse>,
  go: (url: string) => void,
): Promise<void> {
  const { redirectTo } = await doLogout()
  go(redirectTo ?? "/login")
}

/** What the login page says while the database is down. The login routes
 *  answer 503 then, so nobody can reach the Status page that would explain
 *  why. Only the database advisory triggers it; other advisories stay behind
 *  the login. */
export function databaseDownNotice(health: HealthResponse | null): string | null {
  const isDown = health?.advisories?.some((advisory) => advisory.id === "database-unavailable")
  return isDown ? "The database is unavailable, so signing in won't work until it's back." : null
}

/** How long the login page waits for /health. A hung process or a proxy that
 *  never answers must not hold the form behind the skeleton, and that is
 *  exactly when the database notice matters. */
export const LOGIN_HEALTH_TIMEOUT_MS = 3000

/** Fetches what the login page needs, both at once. A failed or timed-out
 *  /health counts as no health, so the form renders without the notice. */
export async function loadLoginContext(
  loadOptions: () => Promise<AuthOptions>,
  loadHealth: (config: AxiosRequestConfig) => Promise<HealthResponse>,
): Promise<{ options: AuthOptions; health: HealthResponse | null }> {
  const [options, health] = await Promise.all([
    loadOptions(),
    loadHealth({ timeout: LOGIN_HEALTH_TIMEOUT_MS }).catch(() => null),
  ])
  return { options, health }
}

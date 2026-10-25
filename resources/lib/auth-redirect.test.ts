import { describe, expect, it, vi } from "vitest"
import {
  LOGIN_ERROR_MESSAGES,
  databaseDownNotice,
  isChromelessRoute,
  loginErrorMessage,
  logoutThenNavigate,
  planLoginForm,
  planLoginRoute,
  planLogoutRoute,
  toMeResult,
} from "@/lib/auth-redirect"
import type { Advisory, HealthResponse } from "@/lib/api"

/** Sentinel: the plan must carry this exact object through to the route. */
const boom = new Error("kaboom")

describe("planLoginRoute", () => {
  it("sends disabled mode home: there is nothing to log into", () => {
    expect(planLoginRoute({ ok: true, me: { mode: "disabled" } })).toEqual({
      action: "redirect",
      to: "/",
    })
  })

  it("sends an already-authenticated visitor home", () => {
    expect(
      planLoginRoute({ ok: true, me: { mode: "session", username: "admin", provider: "password" } }),
    ).toEqual({
      action: "redirect",
      to: "/",
    })
  })

  it("renders the form for an anonymous visitor", () => {
    expect(planLoginRoute({ ok: false, status: 401, error: boom })).toEqual({ action: "render" })
  })

  it("rethrows a server error rather than showing a form that cannot work", () => {
    expect(planLoginRoute({ ok: false, status: 500, error: boom })).toEqual({
      action: "rethrow",
      error: boom,
    })
  })

  it("rethrows a network failure", () => {
    expect(planLoginRoute({ ok: false, status: null, error: boom })).toEqual({
      action: "rethrow",
      error: boom,
    })
  })
})

describe("planLogoutRoute", () => {
  it("sends disabled mode home: there is no session to end", () => {
    expect(planLogoutRoute({ ok: true, me: { mode: "disabled" } })).toEqual({
      action: "redirect",
      to: "/",
    })
  })

  it("ends the session then lands on the login page", () => {
    expect(
      planLogoutRoute({ ok: true, me: { mode: "session", username: "admin", provider: "password" } }),
    ).toEqual({
      action: "endSessionThenRedirect",
      to: "/login",
    })
  })

  it("sends an already-anonymous visitor to the login page", () => {
    expect(planLogoutRoute({ ok: false, status: 401, error: boom })).toEqual({
      action: "redirect",
      to: "/login",
    })
  })

  it("rethrows a server error", () => {
    expect(planLogoutRoute({ ok: false, status: 500, error: boom })).toEqual({
      action: "rethrow",
      error: boom,
    })
  })

  it("rethrows a network failure", () => {
    expect(planLogoutRoute({ ok: false, status: null, error: boom })).toEqual({
      action: "rethrow",
      error: boom,
    })
  })
})

describe("toMeResult", () => {
  it("reads the status off an axios error", () => {
    const error = { isAxiosError: true, response: { status: 401 } }
    expect(toMeResult(error)).toEqual({ ok: false, status: 401, error })
  })

  it("reports a network failure as a null status", () => {
    const error = { isAxiosError: true, response: undefined }
    expect(toMeResult(error)).toEqual({ ok: false, status: null, error })
  })

  it("reports a non-axios throw as a null status", () => {
    expect(toMeResult(boom)).toEqual({ ok: false, status: null, error: boom })
  })

  it("does not treat a look-alike object as an axios error", () => {
    // Without axios.isAxiosError() a plain object shaped like an error would
    // be read as a 401 and silently render the login form.
    const error = { response: { status: 401 } }
    expect(toMeResult(error)).toEqual({ ok: false, status: null, error })
  })

  it("carries the original throw, not a copy of it", () => {
    const result = toMeResult(boom)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(boom)
  })
})

describe("planLoginForm", () => {
  const both = { password: true, oidc: { providerName: "Authelia" } }

  it("shows only the password form when OIDC is off", () => {
    expect(planLoginForm({ password: true, oidc: null }, null)).toEqual({
      oidc: null,
      password: true,
      message: null,
      description: "Enter the administrator credentials configured for this installation.",
    })
  })

  it("shows only the provider button when the password is unset", () => {
    expect(planLoginForm({ password: false, oidc: { providerName: "Authelia" } }, null)).toEqual({
      oidc: { providerName: "Authelia" },
      password: false,
      message: null,
      description: "Sign in with your Authelia account.",
    })
  })

  it("shows both with a neutral description", () => {
    expect(planLoginForm(both, null).description).toBe("Sign in to continue.")
  })

  it("maps every callback error code to its fixed sentence", () => {
    for (const code of ["oidc_denied", "oidc_forbidden", "oidc_failed", "oidc_unavailable"]) {
      expect(planLoginForm(both, code).message).toBe(LOGIN_ERROR_MESSAGES[code])
    }
  })

  it("ignores an unknown error code rather than echoing it", () => {
    expect(planLoginForm(both, "<script>").message).toBeNull()
    for (const code of ["__proto__", "constructor", "toString"]) {
      expect(planLoginForm(both, code).message).toBeNull()
    }
  })
})

describe("isChromelessRoute", () => {
  it("is true for the login page", () => {
    expect(isChromelessRoute("/login")).toBe(true)
  })

  it("is true for the post-logout page", () => {
    expect(isChromelessRoute("/signed-out")).toBe(true)
  })

  it("is false for the app shell and lookalike paths", () => {
    expect(isChromelessRoute("/")).toBe(false)
    expect(isChromelessRoute("/login/x")).toBe(false)
    expect(isChromelessRoute("/signed-out/")).toBe(false)
  })
})

describe("loginErrorMessage", () => {
  it("names a wrong password for a 401", () => {
    const error = { isAxiosError: true, response: { status: 401 } }
    expect(loginErrorMessage(error)).toBe("Invalid username or password")
  })

  it("names the database outage for a 503", () => {
    const error = { isAxiosError: true, response: { status: 503 } }
    expect(loginErrorMessage(error)).toBe(
      "The database is unavailable, so nobody can sign in right now. Try again in a minute.",
    )
  })

  it("does not call any other status a wrong password", () => {
    const error = { isAxiosError: true, response: { status: 500 } }
    expect(loginErrorMessage(error)).toBe("Sign-in failed. Try again.")
  })

  it("covers a network failure and a plain Error", () => {
    expect(loginErrorMessage({ isAxiosError: true, response: undefined })).toBe("Sign-in failed. Try again.")
    expect(loginErrorMessage(new Error("offline"))).toBe("Sign-in failed. Try again.")
  })
})

describe("logoutThenNavigate", () => {
  it("lands on the login page after a logout with no provider", async () => {
    const go = vi.fn()
    await logoutThenNavigate(async () => ({ redirectTo: null }), go)
    expect(go).toHaveBeenCalledExactlyOnceWith("/login")
  })

  it("follows the provider's end-session URL when one is returned", async () => {
    const go = vi.fn()
    await logoutThenNavigate(async () => ({ redirectTo: "https://idp.example/logout" }), go)
    expect(go).toHaveBeenCalledExactlyOnceWith("https://idp.example/logout")
  })

  it("rejects and never navigates when the logout fails", async () => {
    const go = vi.fn()
    const failure = new Error("503")
    await expect(
      logoutThenNavigate(() => Promise.reject(failure), go),
    ).rejects.toBe(failure)
    expect(go).not.toHaveBeenCalled()
  })
})

describe("databaseDownNotice", () => {
  const healthWith = (advisories?: Advisory[]) => ({ advisories }) as HealthResponse
  const advisory = (id: string, summary: string): Advisory => ({ id, severity: "critical", summary })

  it("is null when /health could not be fetched", () => {
    expect(databaseDownNotice(null)).toBeNull()
  })

  it("is null when there are no advisories", () => {
    expect(databaseDownNotice(healthWith([]))).toBeNull()
    expect(databaseDownNotice(healthWith(undefined))).toBeNull()
  })

  it("returns the login notice when the database advisory is present", () => {
    const health = healthWith([
      advisory("geoip-database-stale", "The GeoIP database is old."),
      advisory("database-unavailable", "The database is unreachable."),
    ])
    expect(databaseDownNotice(health)).toBe("The database is unavailable, so signing in won't work until it's back.")
  })

  it("ignores other advisories on their own", () => {
    const health = healthWith([advisory("geoip-database-stale", "The GeoIP database is old.")])
    expect(databaseDownNotice(health)).toBeNull()
  })
})

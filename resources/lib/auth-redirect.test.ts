import { describe, expect, it } from "vitest"
import { planLoginRoute, planLogoutRoute, toMeResult } from "@/lib/auth-redirect"

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
    expect(planLoginRoute({ ok: true, me: { mode: "session", username: "admin" } })).toEqual({
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
    expect(planLogoutRoute({ ok: true, me: { mode: "session", username: "admin" } })).toEqual({
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

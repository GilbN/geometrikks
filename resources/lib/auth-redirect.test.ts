import { describe, expect, it } from "vitest"
import { planLoginRoute, planLogoutRoute, toMeResult } from "@/lib/auth-redirect"

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
    expect(planLoginRoute({ ok: false, status: 401 })).toEqual({ action: "render" })
  })

  it("rethrows a server error rather than showing a form that cannot work", () => {
    expect(planLoginRoute({ ok: false, status: 500 })).toEqual({ action: "rethrow" })
  })

  it("rethrows a network failure", () => {
    expect(planLoginRoute({ ok: false, status: null })).toEqual({ action: "rethrow" })
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
    expect(planLogoutRoute({ ok: false, status: 401 })).toEqual({
      action: "redirect",
      to: "/login",
    })
  })

  it("rethrows a server error", () => {
    expect(planLogoutRoute({ ok: false, status: 500 })).toEqual({ action: "rethrow" })
  })

  it("rethrows a network failure", () => {
    expect(planLogoutRoute({ ok: false, status: null })).toEqual({ action: "rethrow" })
  })
})

describe("toMeResult", () => {
  it("reads the status off an axios error", () => {
    expect(toMeResult({ isAxiosError: true, response: { status: 401 } })).toEqual({
      ok: false,
      status: 401,
    })
  })

  it("reports a network failure as a null status", () => {
    expect(toMeResult({ isAxiosError: true, response: undefined })).toEqual({
      ok: false,
      status: null,
    })
  })

  it("reports a non-axios throw as a null status", () => {
    expect(toMeResult(new Error("kaboom"))).toEqual({ ok: false, status: null })
  })

  it("does not treat a look-alike object as an axios error", () => {
    // Without axios.isAxiosError() a plain object shaped like an error would
    // be read as a 401 and silently render the login form.
    expect(toMeResult({ response: { status: 401 } })).toEqual({ ok: false, status: null })
  })
})

import { createFileRoute, redirect } from "@tanstack/react-router"
import { fetchMe, logout } from "@/lib/api"
import { planLogoutRoute, toMeResult, type MeResult } from "@/lib/auth-redirect"

/** A bookmarkable equivalent of the sidebar's Log out button, and the reason
 *  /logout cannot land on a dead page when APP_AUTH_DISABLED=true. Renders
 *  nothing: every branch redirects. */
export const Route = createFileRoute("/logout")({
  beforeLoad: async () => {
    let result: MeResult
    let caught: unknown
    try {
      result = { ok: true, me: await fetchMe() }
    } catch (error) {
      caught = error
      result = toMeResult(error)
    }
    const plan = planLogoutRoute(result)
    if (plan.action === "endSessionThenRedirect") {
      await logout()
      throw redirect({ to: plan.to })
    }
    // Same rule as /login: the redirect is thrown outside the try, or the
    // catch above would swallow it. And the rethrow carries the original
    // error rather than a generic replacement.
    if (plan.action === "redirect") throw redirect({ to: plan.to })
    throw caught
  },
  component: () => null,
})

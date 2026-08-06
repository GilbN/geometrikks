import { createFileRoute, redirect } from "@tanstack/react-router"
import { fetchMe, logout } from "@/lib/api"
import { planLogoutRoute, toMeResult, type MeResult } from "@/lib/auth-redirect"

/** A bookmarkable equivalent of the sidebar's Log out button, and the reason
 *  /logout cannot land on a dead page when APP_AUTH_DISABLED=true. Renders
 *  nothing: every branch redirects. */
export const Route = createFileRoute("/logout")({
  beforeLoad: async () => {
    let result: MeResult
    try {
      result = { ok: true, me: await fetchMe() }
    } catch (error) {
      result = toMeResult(error)
    }
    const plan = planLogoutRoute(result)
    if (plan.action === "endSessionThenRedirect") {
      await logout()
      // Hard navigation, matching the sidebar's Log out button: it discards
      // the TanStack Query cache holding the previous session's data, which
      // a client-side redirect would not.
      window.location.href = plan.to
      return
    }
    // Same rule as /login: the redirect is thrown outside the try, or the
    // catch above would swallow it.
    if (plan.action === "redirect") throw redirect({ to: plan.to })
    if (plan.action === "rethrow") throw plan.error
  },
  component: () => null,
})

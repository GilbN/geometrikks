import { useEffect, useState } from "react"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { fetchAuthOptions, fetchMe, login } from "@/lib/api"
import { planLoginForm, planLoginRoute, toMeResult, type MeResult } from "@/lib/auth-redirect"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { BrandScreen } from "@/components/brand/brand-screen"

type LoginSearch = { error?: string }

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search.error === "string" ? { error: search.error } : {},
  beforeLoad: async () => {
    let result: MeResult
    try {
      result = { ok: true, me: await fetchMe() }
    } catch (error) {
      result = toMeResult(error)
    }
    const plan = planLoginRoute(result)
    // Thrown OUTSIDE the try above on purpose: TanStack Router signals
    // navigation by throwing a redirect object, and a try wrapped around
    // this would swallow it and render the form in disabled mode instead.
    if (plan.action === "redirect") throw redirect({ to: plan.to })
    if (plan.action === "rethrow") throw plan.error
    // "render": auth is on and nobody is logged in yet. Which methods exist
    // decides what the page shows.
    return { options: await fetchAuthOptions() }
  },
  component: LoginPage,
  pendingComponent: LoginPagePending,
})

// beforeLoad awaits two round trips before anything paints, so without this
// the anonymous cold load shows a blank page until they return.
function LoginPagePending() {
  return (
    <BrandScreen backdrop="map" title="Sign in" description="Sign in to continue.">
      <div className="space-y-4">
        <Skeleton className="h-9 w-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="h-9 w-full" />
      </div>
    </BrandScreen>
  )
}

function LoginPage() {
  const navigate = useNavigate()
  const { options } = Route.useRouteContext()
  const { error: errorCode } = Route.useSearch()
  // Read once, then dropped from the URL so a reload does not repeat it.
  const [plan] = useState(() => planLoginForm(options, errorCode ?? null))
  useEffect(() => {
    if (errorCode) navigate({ to: "/login", search: {}, replace: true })
  }, [errorCode, navigate])

  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password)
      navigate({ to: "/" })
    } catch {
      setError("Invalid username or password")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BrandScreen backdrop="map" title="Sign in" description={plan.description}>
      <div className="space-y-4">
        {plan.message && <p className="text-sm text-destructive">{plan.message}</p>}
        {plan.oidc && (
          // A plain anchor, not an axios call: the redirect chain has to run
          // as a top-level navigation for the IdP cookies to behave.
          <Button asChild className="w-full">
            <a href="/api/v1/auth/oidc/start">Sign in with {plan.oidc.providerName}</a>
          </Button>
        )}
        {plan.oidc && plan.password && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            or
            <Separator className="flex-1" />
          </div>
        )}
        {plan.password && (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" variant={plan.oidc ? "outline" : "default"} className="w-full" disabled={submitting}>
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        )}
      </div>
    </BrandScreen>
  )
}

import { useState } from "react"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { fetchMe, login } from "@/lib/api"
import { planLoginRoute, toMeResult, type MeResult } from "@/lib/auth-redirect"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { BrandScreen } from "@/components/brand/brand-screen"

export const Route = createFileRoute("/login")({
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
    // "render": auth is on and nobody is logged in yet.
  },
  component: LoginPage,
  pendingComponent: LoginPagePending,
})

// beforeLoad awaits fetchMe() before anything paints, so without this the
// anonymous cold load shows a blank page until that round trip returns.
function LoginPagePending() {
  return (
    <BrandScreen
      title="Sign in"
      description="Enter the administrator credentials configured for this installation."
    >
      <div className="space-y-4">
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
    <BrandScreen
      title="Sign in"
      description="Enter the administrator credentials configured for this installation."
    >
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
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </BrandScreen>
  )
}

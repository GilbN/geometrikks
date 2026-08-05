import { useState } from "react"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { fetchMe, login } from "@/lib/api"
import { planLoginRoute, toMeResult, type MeResult } from "@/lib/auth-redirect"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Globe } from "lucide-react"

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    let result: MeResult
    let caught: unknown
    try {
      result = { ok: true, me: await fetchMe() }
    } catch (error) {
      caught = error
      result = toMeResult(error)
    }
    const plan = planLoginRoute(result)
    // Thrown OUTSIDE the try above on purpose: TanStack Router signals
    // navigation by throwing a redirect object, and a try wrapped around
    // this would swallow it and render the form in disabled mode instead.
    if (plan.action === "redirect") throw redirect({ to: plan.to })
    // Rethrow the original error, not a new one: the error boundary should
    // see the real status, message and stack.
    if (plan.action === "rethrow") throw caught
    // "render": auth is on and nobody is logged in yet.
  },
  component: LoginPage,
  pendingComponent: LoginPagePending,
})

/** The login page's chrome, shared by the form and its pending skeleton so
 *  the two cannot drift apart. */
function LoginCardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Globe className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">GeoMetrikks</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

// beforeLoad awaits fetchMe() before anything paints, so without this the
// anonymous cold load shows a blank page until that round trip returns.
function LoginPagePending() {
  return (
    <LoginCardShell>
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
    </LoginCardShell>
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
    <LoginCardShell>
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
    </LoginCardShell>
  )
}

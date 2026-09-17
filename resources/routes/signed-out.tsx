import { createFileRoute, Link } from "@tanstack/react-router"
import { BrandScreen } from "@/components/brand/brand-screen"
import { Button } from "@/components/ui/button"

/** Return address after the identity provider ends its session. It never
 *  calls /auth/me and never redirects on its own: landing on /login with a
 *  single SSO button would sign the person straight back in. */
export const Route = createFileRoute("/signed-out")({
  component: SignedOutPage,
})

function SignedOutPage() {
  return (
    <BrandScreen
      backdrop="map"
      title="Signed out"
      description="You have been signed out of GeoMetrikks and your identity provider."
    >
      <Button asChild className="w-full">
        <Link to="/login">Sign in again</Link>
      </Button>
    </BrandScreen>
  )
}

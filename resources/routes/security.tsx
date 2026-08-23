import { createFileRoute } from "@tanstack/react-router"
import { ShieldBan } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertsTable } from "@/components/security/alerts-table"
import { CrowdsecUnreachableBanner } from "@/components/security/crowdsec-unreachable-banner"
import { DecisionsTable } from "@/components/security/decisions-table"
import { SecurityStatCards } from "@/components/security/security-stat-cards"
import { ErrorBanner } from "@/components/error-banner"
import { PageHeader } from "@/components/page-header"
import { useCrowdsecLiveUpdates, useCrowdsecStatus } from "@/lib/queries"

export const Route = createFileRoute("/security")({
  component: SecurityPage,
})

function SecurityPage() {
  const { data: status, isLoading, isError } = useCrowdsecStatus()
  useCrowdsecLiveUpdates()

  const header = (
    <PageHeader
      title="Security"
      subtitle="CrowdSec decisions and alerts, cross-referenced with your traffic."
    />
  )

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        {header}
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // A failed status request means the GeoMetrikks backend itself is
  // unreachable or erroring, which is not "integration not configured".
  if (isError || !status) {
    return (
      <div className="p-4 space-y-4">
        {header}
        <ErrorBanner
          title="Failed to load CrowdSec status from the GeoMetrikks backend."
          detail="It will retry automatically."
        />
      </div>
    )
  }

  if (!status.enabled) {
    return (
      <div className="p-4 space-y-4">
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldBan className="h-10 w-10 text-muted-foreground" />
            <p className="font-medium">CrowdSec integration is not configured</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Set CROWDSEC_LAPI_URL and CROWDSEC_BOUNCER_API_KEY to connect
              GeoMetrikks to your CrowdSec Local API, then restart. The README
              covers the setup, including the optional machine credentials
              that enable ban and unban from this page.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {header}
      <CrowdsecUnreachableBanner />
      <SecurityStatCards />
      <DecisionsTable />
      {status.writeEnabled && <AlertsTable />}
    </div>
  )
}

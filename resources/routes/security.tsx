import { createFileRoute } from "@tanstack/react-router"
import { ShieldBan } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertsTable } from "@/components/security/alerts-table"
import { DecisionsTable } from "@/components/security/decisions-table"
import { SecurityStatCards } from "@/components/security/security-stat-cards"
import { useCrowdsecLiveUpdates, useCrowdsecStatus } from "@/lib/queries"

export const Route = createFileRoute("/security")({
  component: SecurityPage,
})

function SecurityPage() {
  const { data: status, isLoading } = useCrowdsecStatus()
  useCrowdsecLiveUpdates()

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!status?.enabled) {
    return (
      <div className="p-4">
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
      <SecurityStatCards />
      <DecisionsTable />
      {status.write_enabled && <AlertsTable />}
    </div>
  )
}

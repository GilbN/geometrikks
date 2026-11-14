import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router"
import { ShieldBan } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AbuseIpdbReportsTable } from "@/components/security/abuseipdb-reports-table"
import { AlertHistoryUnavailable, AlertsTable } from "@/components/security/alerts-table"
import { CrowdsecUnreachableBanner } from "@/components/security/crowdsec-unreachable-banner"
import { DecisionsTable } from "@/components/security/decisions-table"
import { DropNetworksCard } from "@/components/security/drop-networks-card"
import { SecurityStatCards } from "@/components/security/security-stat-cards"
import { ErrorBanner } from "@/components/error-banner"
import { PageHeader } from "@/components/page-header"
import { dropNetworksLoaded } from "@/lib/drop-lists"
import { useAbout, useAbuseIpdbStatus, useCrowdsecLiveUpdates, useCrowdsecStatus } from "@/lib/queries"
import { activeSecurityTab, availableSecurityTabs, type SecurityTab } from "@/lib/security-tabs"

interface SecuritySearch {
  tab?: string
}

export const Route = createFileRoute("/security")({
  validateSearch: (search: Record<string, unknown>): SecuritySearch =>
    typeof search.tab === "string" ? { tab: search.tab } : {},
  component: SecurityPage,
})

const TAB_LABELS: Record<SecurityTab, string> = {
  decisions: "Decisions",
  alerts: "Alerts",
  drop: "DROP",
  reports: "Reports",
}

function SecurityPage() {
  const { data: status, isLoading, isError } = useCrowdsecStatus()
  const { data: abuseIpdbStatus, isLoading: abuseIpdbLoading } = useAbuseIpdbStatus()
  const { data: about } = useAbout()
  const { tab: requestedTab } = Route.useSearch()
  const hash = useLocation({ select: (location) => location.hash })
  const navigate = useNavigate({ from: "/security" })
  useCrowdsecLiveUpdates()

  const crowdsec = status?.enabled === true
  const tabs = availableSecurityTabs({
    crowdsec,
    dropLoaded: about?.dropLists?.enabled === true && dropNetworksLoaded(about.dropLists),
    reporting: abuseIpdbStatus?.reportingEnabled === true,
  })
  const activeTab = activeSecurityTab(requestedTab, hash, tabs)

  const header = (
    <PageHeader
      title="Security"
      subtitle={
        tabs.length > 0 && !crowdsec
          ? "IPs GeoMetrikks has reported to AbuseIPDB."
          : "CrowdSec decisions and alerts, cross-referenced with your traffic."
      }
    />
  )

  if (isLoading || abuseIpdbLoading) {
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
  const statusFailed = isError || !status
  const statusError = (
    <ErrorBanner
      title="Failed to load CrowdSec status from the GeoMetrikks backend."
      detail="It will retry automatically."
    />
  )

  if (statusFailed && activeTab === null) {
    return (
      <div className="p-4 space-y-4">
        {header}
        {statusError}
      </div>
    )
  }

  if (activeTab === null) {
    return (
      <div className="p-4 space-y-4">
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldBan className="h-10 w-10 text-muted-foreground" />
            <p className="font-medium">CrowdSec integration is not configured</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Set CROWDSEC_LAPI_URL and CROWDSEC_BOUNCER_API_KEY to connect
              GeoMetrikks to your CrowdSec Local API, then run docker compose up -d. The README
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
      {statusFailed && statusError}
      {crowdsec && <CrowdsecUnreachableBanner />}
      {crowdsec && <SecurityStatCards />}
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          navigate({
            search: (previous) => ({ ...previous, tab: value === tabs[0] ? undefined : value }),
            hash: "",
            replace: true,
            resetScroll: false,
          })
        }
      >
        {tabs.length > 1 && (
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsContent value={activeTab}>
          {activeTab === "decisions" && <DecisionsTable />}
          {activeTab === "alerts" && (status?.writeEnabled ? <AlertsTable /> : <AlertHistoryUnavailable />)}
          {activeTab === "drop" && <DropNetworksCard />}
          {activeTab === "reports" && <AbuseIpdbReportsTable />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

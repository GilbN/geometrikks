/**
 * Alert history: which scenarios fired, against whom, and what they decided.
 * Machine credentials required (the card only renders when writeEnabled).
 * Selecting a row opens the alert's context, events and decisions.
 */
import { useState } from "react"
import { Loader2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCrowdsecAlerts } from "@/lib/queries"
import type { AlertView } from "@/lib/api"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import {
  ALERT_KIND_OPTIONS,
  alertHistoryFooter,
  alertsEmptyMessage,
  groupConsecutiveAlerts,
  isRunOpen,
  scenarioFilterAllowed,
  toggleRun,
  type AlertKindFilter,
} from "@/lib/crowdsec-alerts"
import { AlertKindHelp } from "@/components/security/alert-kind-help"
import { AlertRunRows } from "@/components/security/alert-run-rows"
import { AlertDetailSheet } from "@/components/security/alert-detail-sheet"

const SINCE_OPTIONS = [
  { key: "24h", label: "Last 24h" },
  { key: "168h", label: "Last 7 days" },
  { key: "720h", label: "Last 30 days" },
] as const

type SinceKey = (typeof SINCE_OPTIONS)[number]["key"]

const MACHINE_CREDENTIAL_CODE_CLASS = "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"

export function AlertHistoryUnavailable() {
  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Alert history</CardTitle>
      </CardHeader>
      <CardContent className="px-6 py-8 text-center text-sm leading-relaxed text-muted-foreground">
        <p>Alert history needs CrowdSec machine credentials.</p>
        <p>
          Set <code className={MACHINE_CREDENTIAL_CODE_CLASS}>CROWDSEC_MACHINE_ID</code> and{" "}
          <code className={MACHINE_CREDENTIAL_CODE_CLASS}>CROWDSEC_MACHINE_PASSWORD</code>, then restart.
        </p>
      </CardContent>
    </Card>
  )
}

export function AlertsTable() {
  const [since, setSince] = useState<SinceKey>("24h")
  const [kind, setKind] = useState<AlertKindFilter>("all")
  const [ip, setIp] = useState<string | undefined>(undefined)
  const [scenario, setScenario] = useState<string | undefined>(undefined)
  const {
    data,
    isLoading,
    isError,
    error,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useCrowdsecAlerts({
    since,
    kind: kind === "all" ? undefined : kind,
    ip,
    scenario,
  })
  const alerts = data?.pages.flatMap((page) => page.alerts)
  const footer = alertHistoryFooter({
    rowCount: alerts?.length ?? 0,
    pageCount: data?.pages.length ?? 0,
    hasNextPage,
    isPlaceholderData,
  })
  const [selected, setSelected] = useState<AlertView | null>(null)
  const [expandedAlertKeys, setExpandedAlertKeys] = useState<ReadonlySet<string>>(() => new Set())

  const filterScenario = (clickedScenario: string) => {
    setScenario(clickedScenario)
    if (!scenarioFilterAllowed(kind)) setKind("all")
  }

  const changeKind = (nextKind: AlertKindFilter) => {
    setKind(nextKind)
    if (!scenarioFilterAllowed(nextKind)) setScenario(undefined)
  }

  return (
    <Card className="py-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Alert history</CardTitle>
        <Tabs value={since} onValueChange={(value) => setSince(value as SinceKey)}>
          <TabsList>
            {SINCE_OPTIONS.map((option) => (
              <TabsTrigger key={option.key} value={option.key}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 pb-2 -mt-6">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 overflow-x-auto">
              <Tabs value={kind} onValueChange={(value) => changeKind(value as AlertKindFilter)}>
                <TabsList aria-label="Alert kind">
                  {ALERT_KIND_OPTIONS.map((option) => (
                    <TabsTrigger key={option.key} value={option.key} className="shrink-0 whitespace-nowrap">
                      {option.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            <AlertKindHelp />
          </div>
          {scenario && (
            <Badge variant="secondary" className="min-w-0 max-w-full shrink gap-1 pr-0.5" title={scenario}>
              <span className="truncate">Scenario: {scenario.split("/").at(-1)}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-4 rounded-full"
                aria-label="Clear scenario filter"
                onClick={() => setScenario(undefined)}
              >
                <X />
              </Button>
            </Badge>
          )}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const value = new FormData(event.currentTarget).get("ip")
            setIp(typeof value === "string" && value.trim() ? value.trim() : undefined)
          }}
        >
          <Input
            name="ip"
            className="h-8 w-[180px]"
            placeholder="Filter by IP"
            aria-label="Filter alerts by IP"
          />
        </form>
      </div>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Scenario</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>AS</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 8 }).map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : alerts &&
                  groupConsecutiveAlerts(alerts).map((alertRun) => (
                    <AlertRunRows
                      key={alertRun.key}
                      run={alertRun}
                      open={isRunOpen(alertRun, expandedAlertKeys)}
                      onToggle={() => setExpandedAlertKeys((current) => toggleRun(current, alertRun))}
                      onOpenAlert={setSelected}
                      onFilterScenario={filterScenario}
                    />
                  ))}
              {!isLoading && isError && !alerts && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-destructive">
                    {crowdsecErrorMessage(error, "Failed to load alerts; the CrowdSec LAPI may be unreachable.")}
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && alerts?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    {alertsEmptyMessage(kind)}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {!isLoading && alerts && alerts.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 text-xs text-muted-foreground">
            <span>{footer.text}</span>
            {footer.showLoadOlder && (
              <Button
                variant="outline"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage && <Loader2 data-icon="inline-start" className="animate-spin" />}
                Load older
              </Button>
            )}
            {isFetchNextPageError && (
              <span className="text-destructive">{crowdsecErrorMessage(error, "Failed to load older alerts.")}</span>
            )}
          </div>
        )}
      </CardContent>
      <AlertDetailSheet alert={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </Card>
  )
}

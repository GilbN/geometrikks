/**
 * Alert history: which scenarios fired, against whom, and what they decided.
 * AlertsTable needs machine credentials and renders only when writeEnabled;
 * AlertHistoryUnavailable takes its place otherwise.
 * Selecting a row opens the alert's context, events and decisions.
 */
import { useMemo, useState } from "react"
import { Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
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
import { useCrowdsecAlertScenarios, useCrowdsecAlerts, useTrimCrowdsecAlerts } from "@/lib/queries"
import type { AlertView } from "@/lib/api"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import {
  ALERT_KIND_OPTIONS,
  MAX_ALERT_SCENARIOS,
  alertHistoryFooter,
  alertsEmptyMessage,
  groupConsecutiveAlerts,
  isRunOpen,
  onlyScenario,
  pickScenarios,
  scenarioFilterAllowed,
  scenarioOptionLabel,
  scenarioOptions,
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
  const [ipText, setIpText] = useState("")
  const [scenarios, setScenarios] = useState<string[]>([])
  const [scenarioPickerOpened, setScenarioPickerOpened] = useState(false)
  const kindParam = kind === "all" ? undefined : kind
  const alertParams = { since, kind: kindParam, ip, scenarios: [...scenarios].sort() }
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
  } = useCrowdsecAlerts(alertParams)
  const backToNewest = useTrimCrowdsecAlerts(alertParams)
  const alerts = data?.pages.flatMap((page) => page.alerts)
  const footer = alertHistoryFooter({
    rowCount: alerts?.length ?? 0,
    pageCount: data?.pages.length ?? 0,
    hasNextPage,
    isPlaceholderData,
    kind,
  })
  const [selected, setSelected] = useState<AlertView | null>(null)
  const [expandedAlertKeys, setExpandedAlertKeys] = useState<ReadonlySet<string>>(() => new Set())

  const scenarioPickerEnabled = scenarioFilterAllowed(kind)
  const {
    data: scenarioCounts,
    isPending: scenarioCountsPending,
    isError: scenarioCountsFailed,
  } = useCrowdsecAlertScenarios(
    { since, kind: kindParam },
    scenarioPickerOpened && scenarioPickerEnabled,
  )
  const countByScenario = useMemo(
    () => new Map(scenarioCounts?.map((scenarioCount) => [scenarioCount.scenario, scenarioCount.count])),
    [scenarioCounts],
  )

  const showOnlyScenario = (scenario: string) => {
    const next = onlyScenario(kind, scenario)
    setKind(next.kind)
    setScenarios(next.scenarios)
  }

  const changeKind = (nextKind: AlertKindFilter) => {
    setKind(nextKind)
    if (!scenarioFilterAllowed(nextKind)) setScenarios([])
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
        <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
          <Tabs
            value={kind}
            onValueChange={(value) => changeKind(value as AlertKindFilter)}
            className="min-w-0 flex-1 sm:flex-none"
          >
            <TabsList
              aria-label="Alert kind"
              className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-auto sm:inline-flex sm:w-fit sm:group-data-horizontal/tabs:h-9"
            >
              {ALERT_KIND_OPTIONS.map((option) => (
                <TabsTrigger key={option.key} value={option.key} className="h-8 sm:h-[calc(100%-1px)]">
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <AlertKindHelp />
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <span title={scenarioPickerEnabled ? undefined : "Bot detection already picks its own scenarios"}>
            <FilterCombobox
              label="Scenario"
              options={scenarioOptions(scenarioCounts, scenarios)}
              selected={scenarios}
              onChange={(picked) => setScenarios((current) => pickScenarios(current, picked))}
              labelFor={(scenario) => scenarioOptionLabel(scenario, countByScenario.get(scenario))}
              loading={scenarioCountsPending}
              emptyText={scenarioCountsFailed ? "Could not load scenarios" : "No alerts in this window"}
              contentClassName="min-w-72"
              onOpenChange={(open) => open && setScenarioPickerOpened(true)}
              disabled={!scenarioPickerEnabled}
              maxSelected={MAX_ALERT_SCENARIOS}
            />
          </span>
          <form
            className="min-w-0 flex-1 sm:flex-none"
            onSubmit={(event) => {
              event.preventDefault()
              setIp(ipText.trim() || undefined)
            }}
          >
            <InputGroup className="h-8 w-full sm:w-[180px]">
              <InputGroupInput
                name="ip"
                value={ipText}
                onChange={(event) => setIpText(event.target.value)}
                placeholder="Filter by IP (Enter)"
                aria-label="Filter alerts by IP"
              />
              {ip && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear IP filter"
                    onClick={() => {
                      setIpText("")
                      setIp(undefined)
                    }}
                  >
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </form>
        </div>
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
            {footer.showBackToNewest && (
              <Button variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => void backToNewest()}>
                Back to newest
              </Button>
            )}
            {isFetchNextPageError && (
              <span className="text-destructive">{crowdsecErrorMessage(error, "Failed to load older alerts.")}</span>
            )}
          </div>
        )}
      </CardContent>
      <AlertDetailSheet
        alert={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onFilterScenario={showOnlyScenario}
      />
    </Card>
  )
}

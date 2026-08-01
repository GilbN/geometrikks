/**
 * Alert history: which scenarios fired, against whom, and what they decided.
 * Machine credentials required (the card only renders when write_enabled).
 */
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"

const SINCE_OPTIONS = [
  { key: "24h", label: "Last 24h" },
  { key: "168h", label: "Last 7 days" },
  { key: "720h", label: "Last 30 days" },
] as const

type SinceKey = (typeof SINCE_OPTIONS)[number]["key"]

export function AlertsTable() {
  const [since, setSince] = useState<SinceKey>("24h")
  const { data: alerts, isLoading, isError } = useCrowdsecAlerts({ since, limit: 50 })

  return (
    <Card className="py-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-base">Alert history</CardTitle>
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
                <TableHead className="text-right">Decisions</TableHead>
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
                : alerts?.map((alert) => (
                    <TableRow key={alert.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(alert.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell
                        className="max-w-[240px] truncate font-mono text-xs"
                        title={alert.message}
                      >
                        {alert.scenario}
                      </TableCell>
                      <TableCell className="font-mono">
                        {alert.value}
                        {alert.scope === "Ip" && <IpBanControls ip={alert.value} />}
                      </TableCell>
                      <TableCell>{alert.country ?? "-"}</TableCell>
                      <TableCell className="max-w-[160px] truncate" title={alert.asName ?? undefined}>
                        {alert.asName ?? "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {alert.machineId ?? "-"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {alert.eventsCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {alert.decisionCount}
                      </TableCell>
                    </TableRow>
                  ))}
              {!isLoading && isError && !alerts && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-destructive">
                    Failed to load alerts; the CrowdSec LAPI may be unreachable.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && alerts?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    No alerts in this window.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

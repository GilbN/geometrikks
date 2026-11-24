import type { SidebarIngestionVariant } from "@/components/settings/status-logic"

type InstanceRateInput = {
  checkingIn: boolean
  payload: { written5M?: number | null } | null
}

/** Records written per minute, from the 5-minute counts in each live instance's
 *  heartbeat. Null until an instance has run for 5 minutes. */
export function requestsPerMinute(instances: readonly InstanceRateInput[] | undefined) {
  let written: number | null = null
  for (const instance of instances ?? []) {
    const count = instance.payload?.written5M
    if (!instance.checkingIn || count == null) continue
    written = (written ?? 0) + count
  }
  return written === null ? null : written / 5
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

export function formatRequestRate(perMinute: number): string {
  if (perMinute > 0 && perMinute < 1) return "<1 req/min"
  return `${compact.format(Math.round(perMinute))} req/min`
}

export function formatNavCount(count: number): string {
  return compact.format(count)
}

export function ingestionInFooter(variant: SidebarIngestionVariant): boolean {
  return variant !== "degraded" && variant !== "attention" && variant !== "offline"
}

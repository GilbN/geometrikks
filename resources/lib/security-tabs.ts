/** Which tabs the Security page shows, which one is open, and whether the page appears in the navigation. */

/** The DROP section's element id, which links to it still use as a hash. */
export const DROP_NETWORKS_CARD_ID = "drop-networks"

export type SecurityTab = "decisions" | "alerts" | "drop" | "reports"

export function availableSecurityTabs({
  crowdsec,
  dropLoaded,
  reporting,
}: {
  crowdsec: boolean
  dropLoaded: boolean
  reporting: boolean
}): SecurityTab[] {
  const tabs: SecurityTab[] = []
  if (crowdsec) {
    tabs.push("decisions", "alerts")
    if (dropLoaded) tabs.push("drop")
  }
  if (reporting) tabs.push("reports")
  return tabs
}

export function activeSecurityTab(
  requested: string | undefined,
  hash: string,
  available: readonly SecurityTab[],
): SecurityTab | null {
  const wanted = requested ?? (hash === DROP_NETWORKS_CARD_ID ? "drop" : undefined)
  return available.find((tab) => tab === wanted) ?? available[0] ?? null
}

/** In the shape `slotFour` takes. Undefined `enabled` means that status has not answered. */
export function securityNavStatus(
  crowdsecEnabled: boolean | undefined,
  crowdsecFailed: boolean,
  reportingEnabled: boolean | undefined,
  reportingFailed: boolean,
): { status: { enabled: boolean } | undefined; isError: boolean } {
  if (crowdsecEnabled === true || reportingEnabled === true) return { status: { enabled: true }, isError: false }
  const crowdsecSettled = crowdsecEnabled !== undefined || crowdsecFailed
  const reportingSettled = reportingEnabled !== undefined || reportingFailed
  if (!crowdsecSettled || !reportingSettled) return { status: undefined, isError: false }
  if (crowdsecFailed && reportingFailed) return { status: undefined, isError: true }
  return { status: { enabled: false }, isError: false }
}

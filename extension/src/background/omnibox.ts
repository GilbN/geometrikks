import { decisionLabel } from "@/lib/crowdsec"
import { parseSingleIp } from "../lib/ip"
import { inspectorUrl } from "../lib/links"
import { escapeXml, firstToken } from "../lib/omnibox"
import { getConnection, getRecent, type RecentLookup } from "../lib/storage"
import type { WorkerDeps } from "./pending-flow"

export const NOT_CONNECTED_SUGGESTION = "Connect GeoMetrikks first"

type Suggest = (suggestions: chrome.omnibox.SuggestResult[]) => void

/** What the last lookup found, as the recent lookups list shows it. */
export function recentSummary(lookup: RecentLookup): string {
  const parts: string[] = []
  if (lookup.decisionType) parts.push(decisionLabel(lookup.decisionType))
  if (lookup.countryCode) parts.push(lookup.countryCode)
  if (lookup.asn !== null)
    parts.push(`AS${lookup.asn}${lookup.asOrganization ? ` ${lookup.asOrganization}` : ""}`)
  if (lookup.dropSblId) parts.push(`DROP ${lookup.dropSblId}`)
  return parts.length > 0 ? `${lookup.ip} · ${parts.join(" · ")}` : `${lookup.ip} · Looked up`
}

export async function handleOmniboxInput(
  text: string,
  suggest: Suggest,
  deps: WorkerDeps,
): Promise<void> {
  const stored = await getConnection(deps.chrome)
  if (stored === null) {
    await deps.chrome.omnibox.setDefaultSuggestion({ description: NOT_CONNECTED_SUGGESTION })
    suggest([])
    return
  }
  const ip = parseSingleIp(firstToken(text))
  if (ip === null) {
    await deps.chrome.omnibox.setDefaultSuggestion({ description: "Open GeoMetrikks" })
    suggest([])
    return
  }
  await deps.chrome.omnibox.setDefaultSuggestion({
    description: escapeXml(`Open ${ip} in the IP inspector`),
  })
  const recent = (await getRecent(stored, deps.chrome)).find((lookup) => lookup.ip === ip)
  // A row whose content equals the typed text merges into the default row.
  suggest(
    recent ? [{ content: `${ip} (recent)`, description: escapeXml(recentSummary(recent)) }] : [],
  )
}

export async function handleOmniboxEnter(
  text: string,
  disposition: `${chrome.omnibox.OnInputEnteredDisposition}`,
  deps: WorkerDeps,
): Promise<void> {
  const stored = await getConnection(deps.chrome)
  if (stored === null) {
    await deps.chrome.runtime.openOptionsPage()
    return
  }
  const ip = parseSingleIp(firstToken(text))
  const url = ip === null ? stored.origin : inspectorUrl(stored.origin, ip)
  if (disposition === "currentTab") await deps.chrome.tabs.update({ url })
  else await deps.chrome.tabs.create({ url, active: disposition !== "newBackgroundTab" })
}

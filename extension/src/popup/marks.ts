import {
  apiV1CrowdsecDecisionsLookupLookupDecisions,
  apiV1DropListsGetDropLists,
} from "@/generated/api/sdk.gen"
import type { DecisionView, DropListsResponse } from "@/generated/api/types.gen"
import { winningDecision } from "@/lib/crowdsec"
import { buildDropIndex, matchDropNetwork, type DropIndex } from "@/lib/drop-lists"
import type { ChromeApi } from "../lib/chrome-api"
import { unwrap, type ExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import { getDropLists, setDropLists } from "../lib/storage"

export interface IpMark {
  decisionType: string | null
  dropSblId: string | null
}

/** The DROP index for this open: the cached lists while fresh, else one
 *  fetch. `identity` is read before the fetch, so lists that arrive after a
 *  server switch are tagged with the old server and never served to the new one. */
export async function loadDropIndex(
  client: ExtensionClient,
  chromeApi: ChromeApi,
  access: Access,
  identity: { origin: string; savedAt: number },
): Promise<DropIndex | null> {
  if (!access.drop) return null
  const cached = await getDropLists(identity, chromeApi)
  if (cached) return buildDropIndex(cached.networks)
  let result
  try {
    result = unwrap<DropListsResponse>(await apiV1DropListsGetDropLists({ client }))
  } catch {
    return null
  }
  if (!result.ok) return null
  await setDropLists(identity, result.data, chromeApi)
  return buildDropIndex(result.data.networks)
}

async function decisionTypeFor(client: ExtensionClient, ip: string): Promise<string | null> {
  try {
    const result = unwrap<DecisionView[]>(
      await apiV1CrowdsecDecisionsLookupLookupDecisions({ client, query: { ip } }),
    )
    return result.ok ? (winningDecision(result.data)?.type ?? null) : null
  } catch {
    return null
  }
}

/** Decision and DROP marks for the listed IPs. A failed lookup leaves its IP
 *  without a decision mark; the rows show either way. */
export async function ipMarks(
  client: ExtensionClient,
  ips: string[],
  access: Access,
  dropIndex: DropIndex | null,
): Promise<Record<string, IpMark>> {
  const entries = await Promise.all(
    ips.map(async (ip): Promise<[string, IpMark]> => {
      const decisionType = access.crowdsec ? await decisionTypeFor(client, ip) : null
      const dropSblId =
        access.drop && dropIndex ? (matchDropNetwork(dropIndex, ip)?.sblId ?? null) : null
      return [ip, { decisionType, dropSblId }]
    }),
  )
  return Object.fromEntries(entries)
}

/** The app's IpLabel tones (`ip-label.tsx`), which the extension can't import
 *  because that component reads the app's query hooks. */
export function decisionTone(type: string): string {
  if (type === "ban") return "bg-destructive/10 text-destructive dark:bg-destructive/20"
  if (type === "captcha") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return "bg-secondary text-secondary-foreground"
}

/** The app's DROP_OUTLINE_CLASS (`drop-mark.tsx`). */
export const DROP_OUTLINE_CLASS =
  "outline-[1.5px] outline-dashed outline-destructive -outline-offset-[1.5px]"

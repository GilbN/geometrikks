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
 *  server switch are tagged with the old server and never served to the new one.
 *  Never rejects: a failed cache read is a miss, a failed write keeps the index. */
export async function loadDropIndex(
  client: ExtensionClient,
  chromeApi: ChromeApi,
  access: Access,
  identity: { origin: string; savedAt: number },
): Promise<DropIndex | null> {
  if (!access.drop) return null
  try {
    const cached = await readCachedLists(identity, chromeApi)
    if (cached) return buildDropIndex(cached.networks)
    const result = unwrap<DropListsResponse>(await apiV1DropListsGetDropLists({ client }))
    if (!result.ok) return null
    const index = buildDropIndex(result.data.networks)
    try {
      await setDropLists(identity, result.data, chromeApi)
    } catch {
      // The next open fetches again.
    }
    return index
  } catch {
    return null
  }
}

async function readCachedLists(
  identity: { origin: string; savedAt: number },
  chromeApi: ChromeApi,
): Promise<DropListsResponse | null> {
  try {
    return await getDropLists(identity, chromeApi)
  } catch {
    return null
  }
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
  dropIndexLoad: DropIndex | null | Promise<DropIndex | null>,
): Promise<Record<string, IpMark>> {
  const dropIndex = await dropIndexLoad
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

/** Red text that stays at 4.5:1 over the row bars and the ban tint, where
 *  plain `text-destructive` falls to about 3.4:1. */
export const ERROR_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--destructive)_70%,var(--foreground))]"

/** The app's IpLabel tones (`ip-label.tsx`), which the extension can't import
 *  because that component reads the app's query hooks. */
export function decisionTone(type: string): string {
  if (type === "ban") return `bg-destructive/10 dark:bg-destructive/20 ${ERROR_TEXT_CLASS}`
  if (type === "captcha") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return "bg-secondary text-secondary-foreground"
}

/** The app's DROP_OUTLINE_CLASS (`drop-mark.tsx`). */
export const DROP_OUTLINE_CLASS =
  "outline-[1.5px] outline-dashed outline-destructive -outline-offset-[1.5px]"

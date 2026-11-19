import { apiV1CrowdsecBanBan, apiV1CrowdsecUnbanUnban } from "@/generated/api/sdk.gen"
import type { UnbanResponse } from "@/generated/api/types.gen"
import { BAN_DURATIONS, forDuration } from "@/lib/crowdsec"
import { unwrap, type ExtensionClient } from "./client"
import type { FailureInput } from "./failures"
import type { BanResult } from "./storage"

export type BanDuration = (typeof BAN_DURATIONS)[number]

function failureMessage(verb: "Ban" | "Unban", ip: string, failure: FailureInput): string {
  if (failure.detail) return failure.detail
  if (failure.networkError || failure.timedOut)
    return `${verb} failed for ${ip}; the server didn't answer.`
  return `${verb} failed for ${ip}.`
}

/** Sent at once; the popup has no undo window. */
export async function banIp(
  client: ExtensionClient,
  ip: string,
  duration: BanDuration,
): Promise<BanResult> {
  const result = unwrap<unknown>(
    await apiV1CrowdsecBanBan({ client, body: { ip, duration: duration.value } }),
  )
  return {
    ok: result.ok,
    ip,
    durationLabel: duration.label,
    message: result.ok
      ? `Banned ${ip} ${forDuration(duration.label)}`
      : failureMessage("Ban", ip, result.failure),
  }
}

/** Removes the IP's own decisions. `deleted: 0` means nothing was removed,
 *  which the user must not read as unbanned. */
export async function unbanIp(
  client: ExtensionClient,
  ip: string,
): Promise<{ ok: boolean; deleted: number; message: string }> {
  const result = unwrap<UnbanResponse>(await apiV1CrowdsecUnbanUnban({ client, body: { ip } }))
  if (!result.ok)
    return { ok: false, deleted: 0, message: failureMessage("Unban", ip, result.failure) }
  const deleted = typeof result.data?.deleted === "number" ? result.data.deleted : 0
  if (deleted === 0) return { ok: false, deleted, message: `No decision on ${ip} to remove.` }
  return { ok: true, deleted, message: `Unbanned ${ip}` }
}

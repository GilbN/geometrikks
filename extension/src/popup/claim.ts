import { realChrome, type ChromeApi } from "../lib/chrome-api"
import type { PendingItem } from "../lib/storage"
import type { OpenContext } from "./open-context"

function isPendingItem(value: unknown): value is PendingItem {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    (item.kind === "lookup" || item.kind === "ban" || item.kind === "not-ip") &&
    typeof item.text === "string" &&
    typeof item.origin === "string"
  )
}

/** Asks the worker for this open's right-click result. The fallback page
 *  claims by id, the toolbar popup by window. Views never read pending
 *  items themselves, so the worker grants each result once. */
export async function claimFromWorker(
  ctx: OpenContext,
  origin: string,
  chromeApi: ChromeApi = realChrome,
): Promise<PendingItem | null> {
  const request =
    ctx.pendingId !== null
      ? { type: "claimPending", id: ctx.pendingId, origin }
      : { type: "claimPending", windowId: ctx.windowId, origin }
  const answer = await chromeApi.runtime.sendMessage(request)
  return isPendingItem(answer) && answer.origin === origin ? answer : null
}

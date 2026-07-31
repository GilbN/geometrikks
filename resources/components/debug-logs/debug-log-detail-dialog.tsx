/**
 * Detail view for one debug line: the full raw line (copyable), the parse
 * error, and the access-log context when the line parsed into one.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { AlertTriangle, Check, Copy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { copyText } from "@/lib/clipboard"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import type { AccessLogDebugEntry } from "@/lib/api"

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono" title={typeof value === "string" ? value : undefined}>
        {value ?? "-"}
      </dd>
    </>
  )
}

export function DebugLogDetailDialog({
  entry,
  onOpenChange,
}: {
  entry: AccessLogDebugEntry | null
  onOpenChange: (open: boolean) => void
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const contentRef = useRef<HTMLDivElement>(null)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])

  async function copyRawLine() {
    if (!entry) return
    // The fallback textarea has to live inside the dialog, or its focus trap
    // steals the selection before the copy runs.
    const copied = await copyText(entry.rawLine, { container: contentRef.current })
    setCopyState(copied ? "copied" : "failed")
    // Drop any pending reset, or an earlier click's timer clears this state early.
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), copied ? 1500 : 4000)
  }

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} className="sm:max-w-2xl">
        {entry && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Debug line #{entry.id}
                {entry.isMalformed ? (
                  <Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    Malformed
                  </Badge>
                ) : (
                  <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    Parsed
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                Captured {new Date(entry.createdAt).toLocaleString()}
                {entry.parseError && ` - ${entry.parseError}`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Raw line</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 pointer-coarse:h-10"
                  onClick={copyRawLine}
                >
                  {copyState === "copied" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : copyState === "failed" ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span className="ml-1 text-xs">
                    {copyState === "copied"
                      ? "Copied"
                      : copyState === "failed"
                        ? "Copy failed"
                        : "Copy"}
                  </span>
                </Button>
              </div>
              {copyState === "failed" && (
                <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
                  Clipboard access was blocked, usually because this page is served over plain
                  HTTP. Select the line below to copy it manually.
                </p>
              )}
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs">
                {entry.rawLine}
              </pre>
            </div>

            {entry.accessLogId !== null ? (
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Linked access log #{entry.accessLogId}
                </span>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-xs">
                  <DetailRow
                    label="Time"
                    value={entry.timestamp ? new Date(entry.timestamp).toLocaleString() : null}
                  />
                  <DetailRow
                    label="IP"
                    value={
                      entry.ipAddress && (
                        <>
                          {entry.ipAddress}
                          <IpBanControls ip={entry.ipAddress} />
                        </>
                      )
                    }
                  />
                  <DetailRow label="Method" value={entry.method} />
                  <DetailRow label="URL" value={entry.url} />
                  <DetailRow label="Host" value={entry.host} />
                  <DetailRow label="Status" value={entry.statusCode} />
                  <DetailRow
                    label="Country"
                    value={
                      entry.countryCode
                        ? `${entry.countryName ?? entry.countryCode} (${entry.countryCode})`
                        : null
                    }
                  />
                  <DetailRow label="City" value={entry.city} />
                  <DetailRow label="User agent" value={entry.userAgent} />
                </dl>
              </div>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No linked access log: this line never parsed into an access-log row.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

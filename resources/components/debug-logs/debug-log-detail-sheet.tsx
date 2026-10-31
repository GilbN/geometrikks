/**
 * Complete record for one debug line: the full raw line (copyable), the
 * parse result, and the access-log context when the line parsed into one.
 */
import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Check, Copy } from "lucide-react"
import { CountryLabel } from "@/components/country-flag"
import { DetailField, DetailSheet } from "@/components/data/detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { DetailIpActions, DetailIpBlock } from "@/components/ip-actions/detail-ip"
import type { AccessLogDebugEntry } from "@/lib/api"
import type { IpRowValues } from "@/lib/ip-filter-targets"

/** The linked access log's IP, or null for a line that never parsed. */
function ipValues(entry: AccessLogDebugEntry | null): IpRowValues | null {
  if (!entry?.ipAddress) return null
  return { ip: entry.ipAddress, countryCode: entry.countryCode, countryName: entry.countryName, city: entry.city }
}

export function DebugLogDetailSheet({
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
    // The fallback textarea has to live inside the sheet, or its focus trap
    // steals the selection before the copy runs.
    const copied = await copyText(entry.rawLine, { container: contentRef.current })
    setCopyState(copied ? "copied" : "failed")
    // Drop any pending reset, or an earlier click's timer clears this state early.
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), copied ? 1500 : 4000)
  }

  const ip = ipValues(entry)
  return (
    <DetailSheet
      open={entry !== null}
      onOpenChange={onOpenChange}
      title={entry ? `Debug line #${entry.id}` : "Debug line details"}
      description={entry ? `Captured ${new Date(entry.createdAt).toLocaleString()}` : undefined}
      footer={ip && <DetailIpActions values={ip} onNavigate={() => onOpenChange(false)} />}
    >
      {entry && (
        <div ref={contentRef} className="space-y-6">
          {ip && <DetailIpBlock values={ip} />}
          <section className="space-y-2" aria-labelledby="raw-line-heading">
            <div className="flex items-center justify-between gap-3">
              <h3 id="raw-line-heading" className="text-xs font-medium text-muted-foreground">
                Raw line
              </h3>
              <Button variant="ghost" size="sm" className="h-7 px-2 pointer-coarse:h-11" onClick={copyRawLine}>
                {copyState === "copied" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : copyState === "failed" ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span className="ml-1 text-xs">
                  {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
                </span>
              </Button>
            </div>
            {copyState === "failed" && (
              <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
                Clipboard access was blocked, usually because this page is served over plain HTTP.
                Select the line below to copy it manually.
              </p>
            )}
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs">
              {entry.rawLine}
            </pre>
          </section>

          <section className="space-y-1" aria-labelledby="parse-heading">
            <h3 id="parse-heading" className="text-xs font-medium text-muted-foreground">
              Parse result
            </h3>
            <dl>
              <DetailField
                label="Outcome"
                value={
                  entry.isMalformed ? (
                    <Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400">
                      Malformed
                    </Badge>
                  ) : (
                    <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      Parsed
                    </Badge>
                  )
                }
              />
              <DetailField label="Parse error" value={entry.parseError} mono />
            </dl>
          </section>

          {entry.accessLogId !== null ? (
            <section className="space-y-1" aria-labelledby="linked-log-heading">
              <h3 id="linked-log-heading" className="text-xs font-medium text-muted-foreground">
                Linked access log #{entry.accessLogId}
              </h3>
              <dl>
                <DetailField label="Time" value={entry.timestamp ? new Date(entry.timestamp).toLocaleString() : null} />
                <DetailField label="Method" value={entry.method} mono />
                <DetailField label="URL" value={entry.url} mono />
                <DetailField label="Host" value={entry.host} mono />
                <DetailField label="Status" value={entry.statusCode} mono />
                <DetailField
                  label="Country"
                  value={
                    entry.countryCode && (
                      <CountryLabel code={entry.countryCode} name={entry.countryName}>
                        {`${entry.countryName ?? entry.countryCode} (${entry.countryCode})`}
                      </CountryLabel>
                    )
                  }
                />
                <DetailField label="City" value={entry.city} />
                <DetailField label="User agent" value={entry.userAgent} mono />
              </dl>
            </section>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              No linked access log: this line never parsed into an access-log row.
            </p>
          )}
        </div>
      )}
    </DetailSheet>
  )
}

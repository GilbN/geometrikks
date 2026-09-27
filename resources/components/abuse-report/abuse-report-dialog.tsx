/**
 * Builds an abuse report for one IP or the busiest IPs of an ASN, shows it
 * as plain text or CSV, and copies or downloads it. The abuse contact comes
 * from an RDAP lookup that runs only when asked for.
 */
import { useMemo, useRef, useState } from "react"
import { Check, Copy, Download, Loader2, MailWarning, Maximize2, Minimize2, RotateCw, Search, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ExternalLink } from "@/components/crowdsec/external-link"
import type { AbuseContactResponse, AbuseReportResponse } from "@/generated/api/types.gen"
import { formatAbuseReportCsv, formatAbuseReportText, reportFileName } from "@/lib/abuse-report"
import type { AbuseReportTarget } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { useAbuseContact, useAbuseReport } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"
import { formatTs } from "@/lib/datetime"
import { cn } from "@/lib/utils"

export type AbuseReportSubject =
  | { kind: "ip"; ip: string; asn?: number | null; organization?: string | null }
  | { kind: "asn"; asn: number; organization?: string | null }

type Format = "text" | "csv"

const LINES_PER_IP = [10, 20, 50, 100, 200] as const
const MAX_IPS = [10, 25, 50, 100] as const
const DEFAULT_LINES = { ip: 50, asn: 20 } as const
const DEFAULT_MAX_IPS = 25

/** The API error envelope's detail, else the fallback. */
function errorDetail(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "detail" in err && typeof err.detail === "string") return err.detail
  return fallback
}

const asLabel = (asn: number, organization?: string | null) => `AS${asn}${organization ? ` ${organization}` : ""}`

export function AbuseReportDialog({
  subject,
  open,
  onOpenChange,
}: {
  subject: AbuseReportSubject | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const openChange = (next: boolean) => {
    if (!next) setExpanded(false)
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent
        className={cn(
          expanded
            ? "flex h-dvh max-h-none w-screen max-w-none flex-col rounded-none sm:max-w-none"
            : "max-h-[90vh] overflow-y-auto sm:max-w-3xl",
        )}
        onEscapeKeyDown={(event) => {
          // The first Escape leaves full screen, the next closes the dialog.
          if (expanded) {
            event.preventDefault()
            setExpanded(false)
          }
        }}
      >
        {subject && (
          <AbuseReportBody key={subjectKey(subject)} subject={subject} expanded={expanded} onExpandedChange={setExpanded} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function subjectKey(subject: AbuseReportSubject): string {
  return subject.kind === "ip" ? `ip:${subject.ip}` : `asn:${subject.asn}`
}

function AbuseReportBody({
  subject,
  expanded,
  onExpandedChange,
}: {
  subject: AbuseReportSubject
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [scope, setScope] = useState<"ip" | "asn">(subject.kind)
  const [format, setFormat] = useState<Format>("text")
  const [linesPerIp, setLinesPerIp] = useState<number>(DEFAULT_LINES[subject.kind])
  const [maxIps, setMaxIps] = useState<number>(DEFAULT_MAX_IPS)
  const [lookups, setLookups] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const { range, customRange } = useTimeRange()

  const asn = subject.asn ?? null
  const target: AbuseReportTarget =
    scope === "asn" && asn != null ? { kind: "asn", asn } : { kind: "ip", ip: subject.kind === "ip" ? subject.ip : "" }
  const targetKey = target.kind === "ip" ? `ip:${target.ip}` : `asn:${target.asn}`

  const report = useAbuseReport(target, { maxIps, linesPerIp, enabled: true })
  const contact = useAbuseContact(target, lookups.has(targetKey))

  const data = report.data
  const text = useMemo(() => {
    if (!data) return ""
    return format === "text" ? formatAbuseReportText(data, contact.data) : formatAbuseReportCsv(data)
  }, [data, contact.data, format])

  const period =
    range === "custom" && customRange
      ? `${formatTs(customRange.from, "hourly")} to ${formatTs(customRange.to, "hourly")}`
      : rangeSubtitle(range)

  const switchScope = (next: "ip" | "asn") => {
    setScope(next)
    setLinesPerIp(DEFAULT_LINES[next])
  }

  async function copy() {
    // Inside the dialog, or its focus trap steals the fallback's selection.
    const ok = await copyText(text, { container: container.current })
    if (!ok) {
      toast.error("The browser blocked the copy. Download the report instead.")
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function download() {
    if (!data) return
    const blob = new Blob([text], { type: format === "text" ? "text/plain;charset=utf-8" : "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = reportFileName(data, format === "text" ? "txt" : "csv")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const title = target.kind === "asn" ? asLabel(target.asn, subject.organization) : target.ip
  const loading = report.isLoading || (report.isPlaceholderData && report.isFetching)

  return (
    <div ref={container} className={cn("flex min-w-0 flex-col gap-4", expanded && "min-h-0 flex-1")}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MailWarning className="size-4 text-muted-foreground" />
          Abuse report: <span className="font-mono">{title}</span>
        </DialogTitle>
        <DialogDescription>{period}, times in UTC.</DialogDescription>
      </DialogHeader>

      <div className={cn("flex flex-wrap items-end gap-x-4 gap-y-3", expanded && "hidden")}>
        {subject.kind === "ip" && asn != null && (
          <div className="space-y-1.5">
            <Label>Report on</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={scope}
              onValueChange={(value) => value && switchScope(value as "ip" | "asn")}
            >
              <ToggleGroupItem value="ip">This IP</ToggleGroupItem>
              <ToggleGroupItem value="asn">All of AS{asn}</ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}
        {target.kind === "asn" && (
          <div className="space-y-1.5">
            <Label htmlFor="abuse-max-ips">Addresses</Label>
            <Select value={String(maxIps)} onValueChange={(value) => setMaxIps(Number(value))}>
              <SelectTrigger id="abuse-max-ips" size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAX_IPS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    Busiest {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="abuse-lines">Log lines per IP</Label>
          <Select value={String(linesPerIp)} onValueChange={(value) => setLinesPerIp(Number(value))}>
            <SelectTrigger id="abuse-lines" size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINES_PER_IP.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Format</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={format}
            onValueChange={(value) => value && setFormat(value as Format)}
          >
            <ToggleGroupItem value="text">Text</ToggleGroupItem>
            <ToggleGroupItem value="csv">CSV</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {!expanded && (
      <ContactPanel
        target={target}
        contact={contact.data}
        requested={lookups.has(targetKey)}
        loading={contact.isFetching}
        error={contact.isError ? errorDetail(contact.error, "The RDAP lookup failed.") : null}
        onLookup={() => (lookups.has(targetKey) ? void contact.refetch() : setLookups(new Set(lookups).add(targetKey)))}
      />
      )}

      {!expanded && data && !report.isPlaceholderData && <ReportNotes report={data} />}

      <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          The report leaves out your hostnames, instance names, referrers and manual ban reasons, and tries to strip
          your server address and credentials such as API keys from the paths. It can miss some, so read it before
          you send it.
        </span>
      </p>

      <div className={cn("flex flex-col gap-1.5", expanded && "min-h-0 flex-1")}>
        {data && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Preview</span>
            <span className="flex items-center gap-1">
              {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Updating" />}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => onExpandedChange(!expanded)}
              >
                {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                {expanded ? "Exit full screen" : "Full screen"}
              </Button>
            </span>
          </div>
        )}
        {report.isError && !data ? (
          <div className="flex items-center gap-3 text-sm text-destructive">
            {errorDetail(report.error, "Could not build the report.")}
            <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" onClick={() => void report.refetch()}>
              <RotateCw className="size-3" />
              Retry
            </Button>
          </div>
        ) : !data ? (
          <div className="relative">
            <Skeleton className="h-72 w-full" />
            <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Building the report…
            </div>
          </div>
        ) : (
          <pre
            aria-label="Report preview"
            className={cn(
              "overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre",
              expanded ? "min-h-0 flex-1 text-xs" : "h-[min(24rem,45vh)]",
              loading && "opacity-50",
            )}
          >
            {text}
          </pre>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={download} disabled={!data || loading}>
          <Download data-icon="inline-start" />
          Download .{format === "text" ? "txt" : "csv"}
        </Button>
        <Button onClick={() => void copy()} disabled={!data || loading}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </DialogFooter>
    </div>
  )
}

function ContactPanel({
  target,
  contact,
  requested,
  loading,
  error,
  onLookup,
}: {
  target: AbuseReportTarget
  contact: AbuseContactResponse | undefined
  requested: boolean
  loading: boolean
  error: string | null
  onLookup: () => void
}) {
  const what = target.kind === "ip" ? "address" : "AS number"
  if (!contact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" disabled={loading} onClick={onLookup}>
          {loading ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
          {requested && error ? "Try again" : "Find abuse contact"}
        </Button>
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span>Asks the regional registry over RDAP. Only the {what} leaves this server.</span>
        )}
      </div>
    )
  }
  const holder = [contact.name, contact.cidrs.join(", ")].filter(Boolean).join(" · ")
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs">
      <span className="text-muted-foreground">Abuse contact</span>
      {contact.abuseEmails.length ? (
        contact.abuseEmails.map((email) => <EmailChip key={email} email={email} />)
      ) : (
        <span className="text-amber-600 dark:text-amber-400">The registry record lists no abuse email.</span>
      )}
      {holder && <span className="text-muted-foreground">{holder}</span>}
      <ExternalLink href={contact.rdapUrl}>RDAP record ({contact.registry})</ExternalLink>
    </div>
  )
}

function EmailChip({ email }: { email: string }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [copied, setCopied] = useState(false)
  async function copy() {
    const ok = await copyText(email, { container: anchor.current })
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span ref={anchor} className="inline-flex items-center gap-1 font-mono">
      {email}
      <Button variant="ghost" size="icon" className="size-6" onClick={() => void copy()} aria-label={`Copy ${email}`}>
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </span>
  )
}

function ReportNotes({ report }: { report: AbuseReportResponse }) {
  const notes: string[] = []
  if (report.target.kind === "asn") {
    notes.push(
      report.ipCount > report.ips.length
        ? `The ${report.ips.length} busiest of ${report.ipCount.toLocaleString()} addresses, ${report.totalRequests.toLocaleString()} requests in all.`
        : `${report.ipCount.toLocaleString()} addresses, ${report.totalRequests.toLocaleString()} requests.`,
    )
  }
  if (report.totalRequests === 0) notes.push("The access logs hold no requests for this range.")
  if (report.redactions > 0) {
    notes.push(
      `The report scrubs your hostnames or server address in ${report.redactions.toLocaleString()} ${report.redactions === 1 ? "place" : "places"}.`,
    )
  }
  const warning = report.crowdsec.status !== "ok" && report.crowdsec.status !== "disabled" ? report.crowdsec.message : null
  if (!notes.length && !warning) return null
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {notes.length > 0 && <p>{notes.join(" ")}</p>}
      {warning && <p className="text-amber-600 dark:text-amber-400">{warning}</p>}
    </div>
  )
}

/** Opens the dialog for one IP from the inspector footer. */
export function AbuseReportButton({ subject }: { subject: AbuseReportSubject }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Icon only on a phone, like the other inspector footer buttons. */}
      <Button size="sm" variant="outline" className="max-sm:w-8 max-sm:px-0" onClick={() => setOpen(true)} aria-label="Abuse report" title="Abuse report">
        <MailWarning />
        <span className="max-sm:hidden">Abuse report</span>
      </Button>
      <AbuseReportDialog subject={subject} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** One dialog shared by a table's rows: `openFor` picks the subject. */
export function useAbuseReportDialog() {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState<AbuseReportSubject | null>(null)
  const openFor = (next: AbuseReportSubject) => {
    setSubject(next)
    setOpen(true)
  }
  // The subject outlives the close so the body stays put while the dialog animates out.
  const dialog = <AbuseReportDialog subject={subject} open={open} onOpenChange={setOpen} />
  return { openFor, dialog }
}

/** The row button that opens a shared dialog for an ASN. */
export function AsnReportButton({ asn, organization, onOpen }: { asn: number; organization?: string | null; onOpen: (subject: AbuseReportSubject) => void }) {
  const label = `Abuse report for AS${asn}`
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      onClick={() => onOpen({ kind: "asn", asn, organization })}
      aria-label={label}
      title={label}
    >
      <MailWarning className="size-3.5" />
    </Button>
  )
}

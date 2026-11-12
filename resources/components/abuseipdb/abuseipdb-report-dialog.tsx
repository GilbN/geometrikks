/**
 * Reports one IP to AbuseIPDB in the operator's name. Categories, comment and
 * attack time start from the redacted abuse report evidence and stay editable;
 * everything sent becomes public on AbuseIPDB.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import { SideDrawerClose } from "@/components/map/SideDrawer"
import { focusDrawerTitle } from "@/components/settings/api-keys-phone"
import type { AbuseReportResponse, ReportIpDto, StoredReportDto } from "@/generated/api/types.gen"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"
import { errorDetail } from "@/lib/abuse-report"
import {
  ABUSEIPDB_CATEGORIES,
  FALLBACK_CATEGORY_IDS,
  FEATURED_CATEGORY_IDS,
  MAX_COMMENT_LENGTH,
  REPORT_INTERVAL_MS,
  agoText,
  buildReportComment,
  categoriesForScenarios,
  commentLength,
  defaultAttackTime,
  localScenarios,
} from "@/lib/abuseipdb"
import { TIME_RANGE_PRESETS, formatNumber, type CustomTimeRange, type TimeRangeValue } from "@/lib/api"
import { formatTs } from "@/lib/datetime"
import {
  useAbuseIpdbCheck,
  useAbuseIpdbReports,
  useAbuseIpdbStatus,
  useAbuseReportForRange,
  useSubmitAbuseIpdbReport,
} from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"
import { cn } from "@/lib/utils"

interface WindowSelection {
  range: TimeRangeValue
  customRange: CustomTimeRange | null
}

interface Prefill {
  categories: number[]
  fromCrowdsec: boolean
  comment: string
  attackTime: string
  /** The evidence's own instant behind `attackTime`. */
  attackTimeIso: string | null
  attackTimeSource: string
}

const CATEGORY_NAMES = new Map(ABUSEIPDB_CATEGORIES.map((category) => [category.id, category.name]))
const MORE_CATEGORY_IDS = ABUSEIPDB_CATEGORIES.map((category) => category.id).filter(
  (id) => !FEATURED_CATEGORY_IDS.includes(id),
)
function utcMinutes(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ")
}

/** A datetime-local value: the browser's wall clock, not UTC. */
function localInputValue(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Null for an empty or incomplete value, which only disables Send. */
function parseAttackTime(localValue: string, prefilledIso: string | null): { iso: string } | { error: string } | null {
  if (!localValue) return null
  // In the hour a DST change repeats, one wall-clock time names two instants,
  // so an untouched prefill sends the evidence's own instant.
  const untouched = prefilledIso !== null && localValue === localInputValue(prefilledIso)
  const attackTime = new Date(untouched ? prefilledIso : localValue)
  if (Number.isNaN(attackTime.getTime())) return null
  // A time the clocks skip comes back moved by the length of the gap.
  if (localInputValue(attackTime.toISOString()) !== localValue.slice(0, 16)) {
    return { error: "That time doesn't exist in your time zone, because the clocks skip it." }
  }
  if (attackTime.getTime() > Date.now()) return { error: "The attack time can't be in the future." }
  return { iso: attackTime.toISOString() }
}

function prefillFrom(ipEvidence: ReportIpDto | undefined): Prefill {
  if (!ipEvidence) {
    return {
      categories: [...FALLBACK_CATEGORY_IDS],
      fromCrowdsec: false,
      comment: "",
      attackTime: "",
      attackTimeIso: null,
      attackTimeSource: "nothing in the window to date it",
    }
  }
  const scenarios = localScenarios(ipEvidence)
  const { ids, fromCrowdsec } = categoriesForScenarios(scenarios)
  const attackTime = defaultAttackTime(ipEvidence)
  return {
    categories: ids,
    fromCrowdsec,
    comment: buildReportComment(ipEvidence, scenarios),
    attackTime: attackTime ? localInputValue(attackTime) : "",
    attackTimeIso: attackTime,
    attackTimeSource: ipEvidence.firstSeen
      ? "first request in the window"
      : attackTime
        ? "first CrowdSec alert in the window"
        : "nothing in the window to date it",
  }
}

function networkLine(ipEvidence: ReportIpDto | undefined): string {
  if (!ipEvidence) return ""
  const network = ipEvidence.asn != null ? `AS${ipEvidence.asn}${ipEvidence.asnOrganization ? ` ${ipEvidence.asnOrganization}` : ""}` : null
  return [network, ipEvidence.countryName ?? ipEvidence.countryCode].filter(Boolean).join(" · ")
}

function reporterName(report: StoredReportDto): string {
  if (report.reporterKind === "anonymous") return "auth disabled"
  return report.reporterName ?? (report.reporterKind === "api_key" ? "a deleted API key" : "a deleted user")
}

function earlierReportText(report: StoredReportDto): string {
  const sent = `${utcMinutes(report.reportedAt)} UTC · ${report.categories.join(", ")} · by ${reporterName(report)}`
  return report.status === "unconfirmed" ? `${sent} · may have been sent` : sent
}

function Section({
  label,
  labelFor,
  aside,
  children,
}: {
  label: string
  labelFor?: string
  aside?: ReactNode
  children: ReactNode
}) {
  const heading = "text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
  return (
    <section className="flex flex-col gap-1.5 py-1">
      <div className={cn("flex min-h-6 items-center justify-between gap-2", heading)}>
        {labelFor ? <label htmlFor={labelFor}>{label}</label> : <h3>{label}</h3>}
        {aside}
      </div>
      {children}
    </section>
  )
}

function Fact({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted px-2 py-1.5" title={title}>
      <b className="block truncate text-[13px]">{value}</b>
      <span className="block text-[10.5px] leading-tight text-muted-foreground">{label}</span>
    </div>
  )
}

function ScoreRing({ score }: { score: number }) {
  return (
    <div className="relative grid size-9 flex-none place-items-center text-[11px] font-bold">
      <div
        aria-hidden
        className="absolute inset-0 rounded-full [mask:radial-gradient(farthest-side,transparent_calc(100%-4px),#000_calc(100%-4px))]"
        style={{ background: `conic-gradient(var(--destructive) 0 ${score}%, var(--muted) ${score}% 100%)` }}
      />
      {score}%
    </div>
  )
}

function CheckResult({ ip }: { ip: string }) {
  const [requested, setRequested] = useState(false)
  const check = useAbuseIpdbCheck(ip, requested)
  const result = check.data
  return (
    <Section
      label="On AbuseIPDB now"
      aside={
        <Button
          variant="outline"
          size="xs"
          className="normal-case tracking-normal"
          disabled={check.isFetching || result !== undefined}
          onClick={() => (check.isError ? void check.refetch() : setRequested(true))}
        >
          {check.isFetching && <Loader2 data-icon="inline-start" className="animate-spin" />}
          Check (uses 1 check)
        </Button>
      }
    >
      {result ? (
        <div className="flex items-center gap-2.5">
          <ScoreRing score={result.abuseConfidenceScore} />
          <div className="min-w-0 text-xs">
            <b>{result.abuseConfidenceScore}% confidence</b> · {formatNumber(result.totalReports)} reports from{" "}
            {formatNumber(result.numDistinctUsers)} users
            <div className="text-[11px] text-muted-foreground">
              {[
                result.lastReportedAt ? `Last reported ${agoText(result.lastReportedAt, Date.now())}` : "Never reported",
                result.usageType ? `usage type ${result.usageType}` : null,
                result.isTor ? "Tor exit node" : null,
                result.isWhitelisted ? "whitelisted" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
      ) : check.isError ? (
        <p className="text-sm text-red-500">{errorDetail(check.error, "The check failed; AbuseIPDB may be unreachable.")}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">Nothing goes to AbuseIPDB until you press Check.</p>
      )}
    </Section>
  )
}

function EarlierReports({
  reports,
  loading,
  error,
}: {
  reports: StoredReportDto[] | undefined
  loading: boolean
  error: unknown
}) {
  return (
    <Section label="Your earlier reports">
      {loading ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : reports && reports.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          {reports.map((report) => (
            <li key={report.id}>{earlierReportText(report)}</li>
          ))}
        </ul>
      ) : error ? (
        <p className="text-sm text-red-500">{errorDetail(error, "Could not load your earlier reports.")}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">None from GeoMetrikks yet.</p>
      )}
    </Section>
  )
}

function ReportForm({
  ip,
  open,
  session,
  inDrawer,
  side,
  onEdit,
  onDone,
}: {
  ip: string
  open: boolean
  /** Counts the dialog's openings, so a send knows whether its dialog is still the open one. */
  session: number
  inDrawer: boolean
  side: boolean
  /** Runs on every change to the report and on Send. */
  onEdit: () => void
  onDone: () => void
}) {
  const page = useTimeRange()
  const [selection, setSelection] = useState<WindowSelection>(() => ({
    range: page.range,
    customRange: page.range === "custom" ? page.customRange : null,
  }))
  const [pendingSelection, setPendingSelection] = useState<WindowSelection | null>(null)
  const evidence = useAbuseReportForRange({ kind: "ip", ip }, selection, true)
  const { data: status } = useAbuseIpdbStatus()
  const earlierReports = useAbuseIpdbReports(ip, true)
  const submitReport = useSubmitAbuseIpdbReport()

  const [touched, setTouched] = useState(false)
  const [prefilledFrom, setPrefilledFrom] = useState<AbuseReportResponse | null>(null)
  const [prefill, setPrefill] = useState<Prefill | null>(null)
  const [categories, setCategories] = useState<number[]>([])
  const [showAllCategories, setShowAllCategories] = useState(false)
  const [comment, setComment] = useState("")
  const [attackTime, setAttackTime] = useState("")
  const [error, setError] = useState<string | null>(null)

  const report = evidence.data
  const ipEvidence = report?.ips[0]
  if (report !== undefined && !evidence.isPlaceholderData && report !== prefilledFrom && !touched) {
    const next = prefillFrom(ipEvidence)
    setPrefilledFrom(report)
    setPrefill(next)
    setCategories(next.categories)
    setShowAllCategories((shown) => shown || next.categories.some((id) => !FEATURED_CATEGORY_IDS.includes(id)))
    setComment(next.comment)
    setAttackTime(next.attackTime)
  }

  // The previous window's evidence stays on screen while the new one loads, and must not be sent.
  const ready = prefilledFrom !== null && !evidence.isPlaceholderData

  const submitting = useRef(false)
  const sessionRef = useRef(session)
  sessionRef.current = session
  // Radix keeps the form mounted through the close animation, so a closed
  // dialog shows up as open=false before it unmounts.
  const live = useRef(open)
  live.current = open
  useEffect(() => {
    live.current = open
    return () => {
      live.current = false
    }
  }, [open])

  const edit = () => {
    setTouched(true)
    onEdit()
  }
  const toggleCategory = (id: number, pressed: boolean) => {
    setCategories((current) => (pressed ? [...current, id].sort((first, second) => first - second) : current.filter((picked) => picked !== id)))
    edit()
  }
  const applySelection = (next: WindowSelection) => {
    setSelection(next)
    setTouched(false)
    setPrefilledFrom(null)
  }
  const changeWindow = (value: string) => {
    const range = value as TimeRangeValue
    const next = { range, customRange: range === "custom" ? page.customRange : null }
    if (touched) setPendingSelection(next)
    else applySelection(next)
  }

  const windowOptions = TIME_RANGE_PRESETS.map((preset) => ({ value: preset.value, label: rangeSubtitle(preset.value) }))
  if (page.range === "custom" && page.customRange) {
    windowOptions.push({
      value: "custom",
      label: `${formatTs(page.customRange.from, "hourly")} to ${formatTs(page.customRange.to, "hourly")}`,
    })
  }

  const totalRequests = ipEvidence?.totalRequests ?? 0
  const share4xx = totalRequests > 0 ? Math.round(((ipEvidence?.status4xx ?? 0) / totalRequests) * 100) : 0
  const firstSeen = ipEvidence?.firstSeen ?? null
  const alertCount = ipEvidence?.alerts.length ?? 0

  const length = commentLength(comment)
  const parsedAttackTime = parseAttackTime(attackTime, prefill?.attackTimeIso ?? null)
  const attackTimeError = parsedAttackTime && "error" in parsedAttackTime ? parsedAttackTime.error : null
  const attackTimeIso = parsedAttackTime && "iso" in parsedAttackTime ? parsedAttackTime.iso : null
  const latestReport = earlierReports.data?.[0]
  const windowOpen = latestReport !== undefined && Date.now() - Date.parse(latestReport.reportedAt) < REPORT_INTERVAL_MS
  const canSend =
    ready &&
    prefill !== null &&
    categories.length > 0 &&
    comment.trim().length > 0 &&
    length <= MAX_COMMENT_LENGTH &&
    attackTimeIso !== null &&
    !windowOpen &&
    !submitReport.isPending

  const send = async () => {
    if (submitting.current || !canSend || attackTimeIso === null) return
    onEdit()
    submitting.current = true
    const startedIn = sessionRef.current
    const stillOpen = () => live.current && sessionRef.current === startedIn
    setError(null)
    try {
      const response = await submitReport.mutateAsync({
        ipAddress: ip,
        categories,
        comment,
        attackTime: attackTimeIso,
      })
      const score = response.results[0]?.abuseConfidenceScore
      if (stillOpen()) onDone()
      toast.success(
        score == null ? `Reported ${ip} to AbuseIPDB.` : `Reported ${ip} to AbuseIPDB. Confidence score ${score}%.`,
      )
    } catch (err) {
      if (stillOpen()) setError(errorDetail(err, "The report failed; AbuseIPDB may be unreachable."))
    } finally {
      submitting.current = false
    }
  }

  const title = (
    <>
      Report <span className="font-mono [overflow-wrap:anywhere]">{ip}</span> to AbuseIPDB
    </>
  )
  const description = networkLine(ipEvidence) || (evidence.isLoading ? "Loading the evidence…" : "No network known")
  const header = inDrawer ? (
    side ? (
      <DrawerHeader className="flex-row items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <DrawerTitle tabIndex={-1} className="outline-none">
            {title}
          </DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </div>
        <SideDrawerClose />
      </DrawerHeader>
    ) : (
      <DrawerHeader>
        <DrawerTitle tabIndex={-1} className="outline-none">
          {title}
        </DrawerTitle>
        <DrawerDescription>{description}</DrawerDescription>
      </DrawerHeader>
    )
  ) : (
    <DialogHeader className="gap-1 border-b px-4 pt-3.5 pb-2.5 text-left">
      <DialogTitle className="pr-6 text-[15px] leading-snug">{title}</DialogTitle>
      <DialogDescription className="text-xs">{description}</DialogDescription>
    </DialogHeader>
  )

  const shownCategoryIds = showAllCategories ? [...FEATURED_CATEGORY_IDS, ...MORE_CATEGORY_IDS] : FEATURED_CATEGORY_IDS
  const pickedLabel = prefill?.fromCrowdsec
    ? `${prefill.categories.length} picked from CrowdSec`
    : `${FALLBACK_CATEGORY_IDS.length} picked by default`

  const remaining = status?.reports ? `${formatNumber(status.reports.remaining)} reports left today` : null
  const cancelButton = (
    <Button variant="outline" className={inDrawer ? "h-11" : undefined} onClick={onDone}>
      Cancel
    </Button>
  )
  const sendButton = (
    <Button className={inDrawer ? "h-11" : undefined} disabled={!canSend} onClick={() => void send()}>
      {submitReport.isPending && <Loader2 data-icon="inline-start" className="animate-spin" />}
      Send report
    </Button>
  )

  return (
    <>
      {header}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-4",
          inDrawer ? "py-1" : "py-3",
        )}
      >
        <Section
          label="What GeoMetrikks saw"
          aside={
            // A Radix list would cover half a phone drawer, while iOS opens its own wheel for a native select.
            inDrawer ? (
              <NativeSelect
                size="sm"
                aria-label="Evidence window"
                value={selection.range}
                onChange={(event) => changeWindow(event.target.value)}
                className="font-normal tracking-normal normal-case [&>select]:text-base"
              >
                {windowOptions.map((option) => (
                  <NativeSelectOption key={option.value} value={option.value}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <Select value={selection.range} onValueChange={changeWindow}>
                <SelectTrigger size="sm" aria-label="Evidence window" className="data-[size=sm]:h-7 text-xs font-normal normal-case tracking-normal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {windowOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          }
        >
          <div className={cn("grid grid-cols-4 gap-1.5", evidence.isFetching && "opacity-60")}>
            <Fact value={formatNumber(totalRequests)} label="requests" />
            <Fact value={`${share4xx}%`} label="4xx" />
            <Fact
              value={firstSeen ? localInputValue(firstSeen).slice(11) : "none"}
              label="first seen"
              title={firstSeen ? localInputValue(firstSeen).replace("T", " ") : undefined}
            />
            <Fact value={`${alertCount}${ipEvidence?.alertsTruncated ? "+" : ""}`} label="CrowdSec alerts" />
          </div>
          {evidence.isError ? (
            <p className="text-sm text-red-500">{errorDetail(evidence.error, "Could not load the evidence for this window.")}</p>
          ) : (
            !ready && <p className="text-[11px] text-muted-foreground">Loading the evidence for this window…</p>
          )}
        </Section>

        <Section label="Categories" aside={prefill && <span>{pickedLabel}</span>}>
          <div className="flex flex-wrap gap-1.5">
            {shownCategoryIds.map((id) => (
              <Toggle
                key={id}
                variant="outline"
                size="sm"
                pressed={categories.includes(id)}
                disabled={!ready}
                onPressedChange={(pressed) => toggleCategory(id, pressed)}
                className="h-6 min-w-0 rounded-full px-2.5 text-xs font-normal shadow-none aria-pressed:border-primary/70 aria-pressed:bg-primary/20"
              >
                {id} {CATEGORY_NAMES.get(id)}
              </Toggle>
            ))}
            {!showAllCategories && (
              <Button
                variant="outline"
                size="xs"
                className="h-6 rounded-full border-dashed px-2.5 font-normal shadow-none pointer-coarse:min-h-10"
                onClick={() => setShowAllCategories(true)}
              >
                All {ABUSEIPDB_CATEGORIES.length}…
              </Button>
            )}
          </div>
        </Section>

        <Section label="Comment" labelFor="abuseipdb-comment" aside={<span>public on AbuseIPDB</span>}>
          <Textarea
            id="abuseipdb-comment"
            value={comment}
            disabled={!ready}
            onChange={(event) => {
              setComment(event.target.value)
              edit()
            }}
            aria-invalid={length > MAX_COMMENT_LENGTH || undefined}
            className="max-h-60 min-h-20 font-mono text-xs leading-relaxed md:text-xs"
          />
          <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {report && report.redactions > 0 && `Your hosts and addresses scrubbed: ${report.redactions} values`}
            </span>
            <span className={cn(length > MAX_COMMENT_LENGTH && "text-red-500")}>
              {length} / {MAX_COMMENT_LENGTH}
            </span>
          </div>
        </Section>

        <Section label="Attack time" labelFor="abuseipdb-attack-time">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Input
              id="abuseipdb-attack-time"
              type="datetime-local"
              required
              max={localInputValue(new Date().toISOString())}
              value={attackTime}
              disabled={!ready}
              onChange={(event) => {
                setAttackTime(event.target.value)
                edit()
              }}
              aria-invalid={attackTimeError !== null || undefined}
              className={cn(
                "h-8",
                inDrawer
                  ? // iOS Safari sizes its native date control by its content and ignores
                    // width: 100% unless the native look is off, and it centers the value.
                    // As a block it also stops centering the text vertically, so the padding does.
                    "block w-full appearance-none py-[3px] text-left text-base [&::-webkit-date-and-time-value]:text-left"
                  : "w-56 py-0 text-xs md:text-xs",
              )}
            />
            {prefill && <span className="text-[11px] text-muted-foreground">{prefill.attackTimeSource}</span>}
          </div>
          {attackTimeError ? (
            <p className="text-xs text-red-500">{attackTimeError}</p>
          ) : (
            attackTimeIso && <p className="text-[11px] text-muted-foreground">sent as {utcMinutes(attackTimeIso)} UTC</p>
          )}
        </Section>

        {status?.enabled && <CheckResult ip={ip} />}

        <EarlierReports reports={earlierReports.data} loading={earlierReports.isLoading} error={earlierReports.error} />

        {windowOpen && (
          <p className="text-xs text-muted-foreground">
            Reported less than 15 minutes ago. AbuseIPDB takes one report per IP every 15 minutes.
          </p>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {inDrawer ? (
        <DrawerFooter>
          {remaining && <span className="text-center text-[11px] text-muted-foreground">{remaining}</span>}
          {sendButton}
          {cancelButton}
        </DrawerFooter>
      ) : (
        <DialogFooter className="items-center border-t px-4 py-2.5 sm:justify-between">
          <span className="text-[11px] text-muted-foreground">{remaining}</span>
          <div className="flex gap-2">
            {cancelButton}
            {sendButton}
          </div>
        </DialogFooter>
      )}

      <AlertDialog open={pendingSelection !== null} onOpenChange={(next) => !next && setPendingSelection(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              A new window rebuilds the categories, comment and attack time from its evidence.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingSelection) applySelection(pendingSelection)
                setPendingSelection(null)
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Controlled so an IP actions menu can open it for its row's IP. */
export function AbuseIpdbReportDialog({
  ip,
  open,
  onOpenChange,
  returnFocusTo,
}: {
  ip: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Gets focus back on close. Without a trigger of its own the dialog
   *  would otherwise drop focus on the body. */
  returnFocusTo?: RefObject<HTMLElement | null>
}) {
  // Once edited or sent, the report holds its layout through a turn rather than close and lose it.
  const [edited, setEdited] = useState(false)
  if (!open && edited) setEdited(false)
  const markEdited = () => setEdited(true)
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession((current) => current + 1)
  }
  const drawer = usePhoneDrawer("abuseipdb-report", open, () => onOpenChange(false), { keepWhileOpen: edited })
  const restoreFocus = (event: Event) => {
    if (!returnFocusTo?.current) return
    event.preventDefault()
    returnFocusTo.current.focus({ preventScroll: true })
  }
  const form = (
    <ReportForm
      ip={ip}
      open={open}
      session={session}
      inDrawer={drawer.phone}
      side={drawer.side}
      onEdit={markEdited}
      onDone={() => onOpenChange(false)}
    />
  )

  if (drawer.phone) {
    return (
      <Drawer
        key={drawer.key}
        direction={drawer.direction}
        open={drawer.open}
        onOpenChange={onOpenChange}
        onClosed={drawer.onClosed}
        autoFocus
      >
        <DrawerContent
          className={drawer.contentClassName}
          onOpenAutoFocus={focusDrawerTitle}
          onCloseAutoFocus={restoreFocus}
        >
          {form}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={drawer.open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl" onCloseAutoFocus={restoreFocus}>
        {form}
      </DialogContent>
    </Dialog>
  )
}

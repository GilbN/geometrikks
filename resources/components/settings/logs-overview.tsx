/**
 * Live log tail for Settings -> Logs: seeded from the tail endpoint, then
 * appended from the /ws/logs stream. Level/component/search filters, a
 * traceback dialog for exceptions, a full-record detail dialog, and a
 * downloads tab for the raw files behind the stream.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  ArrowUp,
  ChevronsUpDown,
  Download,
  FolderDown,
  Layers,
  Pause,
  Play,
  ScrollText,
  Search,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MonoChip, StatusLed, type LedTone } from "@/components/settings/status-led"
import { useLogFiles, useLogTail, queryKeys } from "@/lib/queries"
import { logStream, type LogRecord, type LogStreamStatus } from "@/lib/logstream"
import { apiV1LogsRotateRotate } from "@/generated/api/sdk.gen"
import type { LogFileView } from "@/generated/api/types.gen"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { rowActivation, stopRowActivation } from "@/components/data/row-activation"
import { VirtualTable, VirtualTableBody } from "@/components/data/virtual-table"

const MAX_RECORDS = 2000
const FLOW_IDLE_MS = 2000
/** geometrikks.server.logging.LOGIN_LOGGER_NAME; login records are broadcast
 * unfiltered alongside every other record and picked out client-side. */
const LOGIN_LOGGER_NAME = "geometrikks.auth.login"

const LEVELS = ["debug", "info", "success", "warning", "error", "critical"] as const

const levelBadgeClasses: Record<string, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  error: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  critical: "border-red-500/50 bg-red-500/20 text-red-700 dark:text-red-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  debug: "border-border bg-muted text-muted-foreground",
}

const ledToneByStatus: Record<LogStreamStatus, LedTone> = {
  connected: "emerald",
  connecting: "amber",
  disconnected: "red",
}

const fileKindLabels: Record<LogFileView["kind"], string> = {
  app: "Application log",
  login: "Login log",
  access: "Access logs",
}
const FILE_KIND_ORDER: LogFileView["kind"][] = ["app", "login", "access"]

/** geometrikks.services.ingestion -> services; falls back to the raw logger name. */
const component = (r: LogRecord): string => r.logger?.split(".")[1] ?? r.logger ?? "app"

const STANDARD_RECORD_KEYS = new Set(["timestamp", "level", "logger", "event", "exception"])

/**
 * Every scalar field of a record besides the standard ones, rendered
 * `key=value` and space-joined, so a row reads e.g. `method=GET path=/api`
 * without opening the detail dialog. Objects/arrays stay dialog-only.
 */
function formatContext(r: LogRecord): string {
  return Object.entries(r)
    .filter(
      ([key, value]) =>
        !STANDARD_RECORD_KEYS.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

/** "All levels" when empty, the value itself for one, "value +N" for more. */
function multiSelectLabel(selected: string[], allLabel: string): string {
  if (selected.length === 0) return allLabel
  if (selected.length === 1) return selected[0]
  return `${selected[0]} +${selected.length - 1}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

interface Entry {
  id: number
  record: LogRecord
}

/** Below this card width a log line goes on two lines, the message on its own. */
const LOG_NARROW_WIDTH = 640

const LOG_COLUMNS = [
  { key: "time" },
  { key: "level" },
  { key: "component" },
  { key: "message", grow: true },
  { key: "traceback" },
] as const

const getEntryKey = (entry: Entry) => entry.id

function LevelBadge({ level }: { level: string | null | undefined }) {
  return (
    <Badge variant="outline" className={cn("gap-1 uppercase", levelBadgeClasses[level ?? ""] ?? levelBadgeClasses.info)}>
      {level ?? "info"}
    </Badge>
  )
}

function LogMessage({ record, className }: { record: LogRecord; className?: string }) {
  const context = formatContext(record)
  const eventText = record.event ?? "(no message)"
  return (
    <span className={cn("font-mono text-xs", className)} title={context ? `${eventText} ${context}` : eventText}>
      {eventText}
      {context ? <span className="text-muted-foreground"> {context}</span> : null}
    </span>
  )
}

function TracebackButton({ record, onOpen }: { record: LogRecord; onOpen: (record: LogRecord) => void }) {
  if (typeof record.exception !== "string" || record.exception.length === 0) return null
  return (
    <span {...stopRowActivation}>
      <Button variant="ghost" size="icon-sm" aria-label="View traceback" onClick={() => onOpen(record)}>
        <Layers className="h-3.5 w-3.5" />
      </Button>
    </span>
  )
}

/** Passes the props VirtualTableBody adds (its measuring ref, index and role)
 *  on to the row element. */
function LogRow({
  entry,
  narrow,
  onOpenRecord,
  onOpenTraceback,
  ...rowProps
}: ComponentProps<"tr"> & {
  entry: Entry
  narrow: boolean
  onOpenRecord: (record: LogRecord) => void
  onOpenTraceback: (record: LogRecord) => void
}) {
  const record = entry.record
  const activation = { ...rowActivation<HTMLTableRowElement>(() => onOpenRecord(record)), ...rowProps }
  const time = record.timestamp ? new Date(record.timestamp) : null
  if (narrow) {
    return (
      <TableRow {...activation}>
        <TableCell className="py-2">
          <div className="flex min-w-0 items-center gap-2">
            <LevelBadge level={record.level} />
            <MonoChip className="min-w-0 truncate">{component(record)}</MonoChip>
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" title={time?.toLocaleString()}>
              {time ? time.toLocaleTimeString() : "-"}
            </span>
            <TracebackButton record={record} onOpen={onOpenTraceback} />
          </div>
          <LogMessage record={record} className="mt-1 line-clamp-2 break-all whitespace-normal" />
        </TableCell>
      </TableRow>
    )
  }
  return (
    <TableRow {...activation}>
      <TableCell className="w-24 py-1.5 text-xs tabular-nums text-muted-foreground">
        <span title={time?.toLocaleString()}>{time ? time.toLocaleTimeString() : "-"}</span>
      </TableCell>
      <TableCell className="w-24 py-1.5">
        <LevelBadge level={record.level} />
      </TableCell>
      <TableCell className="w-28 py-1.5">
        <MonoChip>{component(record)}</MonoChip>
      </TableCell>
      <TableCell className="w-full max-w-0 py-1.5">
        <LogMessage record={record} className="block truncate" />
      </TableCell>
      <TableCell className="w-10 py-1.5">
        <TracebackButton record={record} onOpen={onOpenTraceback} />
      </TableCell>
    </TableRow>
  )
}

export function LogsOverview() {
  const { data: tailRecords } = useLogTail(500)
  const { data: loginTailRecords } = useLogTail(500, "login")
  const { data: files } = useLogFiles()
  const queryClient = useQueryClient()
  const rotateLogs = useMutation({
    mutationFn: async () => {
      const { data } = await apiV1LogsRotateRotate({ throwOnError: true })
      return data
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.logs.files }),
  })

  const [activeTab, setActiveTab] = useState<"app" | "login" | "downloads">("app")

  const [entries, setEntries] = useState<Entry[]>([])
  const seededRef = useRef(false)
  const [loginEntries, setLoginEntries] = useState<Entry[]>([])
  const seededLoginRef = useRef(false)
  const nextIdRef = useRef(0)

  const [status, setStatus] = useState<LogStreamStatus>("connecting")
  const [flowing, setFlowing] = useState(false)
  const flowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [paused, setPaused] = useState(false)
  // New lines also wait while the list is scrolled down, so they don't push
  // away the lines being read. They flow again at the top.
  const [scrolledAway, setScrolledAway] = useState(false)
  const pausedRef = useRef(false)
  const pausedBufferRef = useRef<LogRecord[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [pendingLoginCount, setPendingLoginCount] = useState(0)
  const pauseButtonRef = useRef<HTMLButtonElement | null>(null)
  const [totalDropped, setTotalDropped] = useState(0)

  const [levelFilters, setLevelFilters] = useState<string[]>([])
  const [componentFilters, setComponentFilters] = useState<string[]>([])
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput, 200)

  const [selected, setSelected] = useState<LogRecord | null>(null)
  const [tracebackRecord, setTracebackRecord] = useState<LogRecord | null>(null)
  const [layoutRef, narrow] = useNarrowLayout<HTMLDivElement>(LOG_NARROW_WIDTH)
  const listRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element
      layoutRef(element)
    },
    [layoutRef],
  )
  /** Back to the newest line: the top of the list's own box, or of the page. */
  function showNewest() {
    const list = listRef.current
    const box = list?.querySelector("table")?.parentElement
    if (!list || !box) return
    if (box.scrollHeight > box.clientHeight + 1) {
      box.scrollTo({ top: 0 })
      return
    }
    const main = list.closest("main")
    if (main) main.scrollTo({ top: main.scrollTop + list.getBoundingClientRect().top - main.getBoundingClientRect().top })
  }
  // These dialogs have no trigger for Radix to return focus to, so remember
  // what opened them: the row, or its traceback button.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const openRecord = (record: LogRecord) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelected(record)
  }
  const openTraceback = (record: LogRecord) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setTracebackRecord(record)
  }
  const returnFocus = (event: Event) => {
    event.preventDefault()
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
  }

  function toEntries(records: LogRecord[]): Entry[] {
    return records.map((record) => {
      nextIdRef.current += 1
      return { id: nextIdRef.current, record }
    })
  }

  // Prepend a chronological (oldest-first) batch to a newest-first buffer,
  // capped at MAX_RECORDS. Shared by the live stream and the pause flush.
  function appendCapped(prev: Entry[], records: LogRecord[]): Entry[] {
    const merged = [...toEntries([...records].reverse()), ...prev]
    return merged.length > MAX_RECORDS ? merged.slice(0, MAX_RECORDS) : merged
  }

  // Seed once from the tail backfill; the stream takes over after that.
  useEffect(() => {
    if (tailRecords && !seededRef.current) {
      seededRef.current = true
      setEntries(toEntries([...(tailRecords as LogRecord[])].reverse()))
    }
    // Intentionally seed once: `tailRecords` is a stable staleTime:Infinity
    // query result and toEntries is a plain closure, not a dependency.
  }, [tailRecords])

  // Same, for the login buffer.
  useEffect(() => {
    if (loginTailRecords && !seededLoginRef.current) {
      seededLoginRef.current = true
      setLoginEntries(toEntries([...(loginTailRecords as LogRecord[])].reverse()))
    }
  }, [loginTailRecords])

  function flushBuffer() {
    const buffered = pausedBufferRef.current
    pausedBufferRef.current = []
    setPendingCount(0)
    setPendingLoginCount(0)
    if (buffered.length > 0) {
      setEntries((prev) => appendCapped(prev, buffered))
      const loginBuffered = buffered.filter((r) => r.logger === LOGIN_LOGGER_NAME)
      if (loginBuffered.length > 0) {
        setLoginEntries((prev) => appendCapped(prev, loginBuffered))
      }
    }
  }

  useEffect(() => {
    pausedRef.current = paused || scrolledAway
    if (!paused && !scrolledAway) flushBuffer()
  }, [paused, scrolledAway])

  useEffect(() => {
    const unsubscribeRecords = logStream.onRecords((records, dropped) => {
      if (dropped) setTotalDropped((d) => d + dropped)
      if (records.length === 0) return

      setFlowing(true)
      if (flowTimerRef.current) clearTimeout(flowTimerRef.current)
      flowTimerRef.current = setTimeout(() => setFlowing(false), FLOW_IDLE_MS)

      if (pausedRef.current) {
        const combined = [...pausedBufferRef.current, ...records]
        const overflow = Math.max(0, combined.length - MAX_RECORDS)
        if (overflow > 0) setTotalDropped((d) => d + overflow)
        pausedBufferRef.current = combined.slice(-MAX_RECORDS)
        setPendingCount(pausedBufferRef.current.length)
        setPendingLoginCount(pausedBufferRef.current.filter((r) => r.logger === LOGIN_LOGGER_NAME).length)
        return
      }

      setEntries((prev) => appendCapped(prev, records))
      const loginRecords = records.filter((r) => r.logger === LOGIN_LOGGER_NAME)
      if (loginRecords.length > 0) {
        setLoginEntries((prev) => appendCapped(prev, loginRecords))
      }
    })
    const unsubscribeStatus = logStream.onStatus(setStatus)
    return () => {
      unsubscribeRecords()
      unsubscribeStatus()
      if (flowTimerRef.current) clearTimeout(flowTimerRef.current)
    }
    // Intentionally mount-once: pausedRef mirrors `paused` so this
    // subscription does not need to be recreated when it changes.
  }, [])

  function togglePause() {
    // Resuming further down the list shows what was held, like the pill does.
    if (paused && scrolledAway) showNewest()
    setPaused((current) => !current)
  }

  const activeEntries = activeTab === "login" ? loginEntries : entries
  const activePending = activeTab === "login" ? pendingLoginCount : pendingCount

  const components = useMemo(() => {
    const set = new Set<string>()
    for (const e of activeEntries) set.add(component(e.record))
    return Array.from(set).sort()
  }, [activeEntries])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return activeEntries.filter((e) => {
      const r = e.record
      if (levelFilters.length > 0 && !levelFilters.includes(r.level ?? "")) return false
      if (componentFilters.length > 0 && !componentFilters.includes(component(r))) return false
      if (needle) {
        const eventMatch = r.event?.toLowerCase().includes(needle) ?? false
        if (!eventMatch && !JSON.stringify(r).toLowerCase().includes(needle)) return false
      }
      return true
    })
  }, [activeEntries, levelFilters, componentFilters, search])

  const groupedFiles = useMemo(() => {
    const groups = new Map<LogFileView["kind"], LogFileView[]>()
    for (const f of files ?? []) {
      const list = groups.get(f.kind) ?? []
      list.push(f)
      groups.set(f.kind, list)
    }
    return FILE_KIND_ORDER.map((kind) => ({ kind, files: groups.get(kind) ?? [] })).filter(
      (g) => g.files.length > 0,
    )
  }, [files])

  const ledTone: LedTone = paused ? "amber" : ledToneByStatus[status]
  const ledPulse = !paused && status === "connected" && flowing

  return (
    <div className="space-y-4">
      {/* Clips like the default but lets the new-lines pill stick to the page. */}
      <Card className="overflow-clip">
        <CardHeader>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "app" | "login" | "downloads")}
          >
            <TabsList>
              <TabsTrigger value="app">System log</TabsTrigger>
              <TabsTrigger value="login">Login log</TabsTrigger>
              <TabsTrigger value="downloads">Downloads</TabsTrigger>
            </TabsList>
          </Tabs>
          {activeTab === "downloads" ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <FolderDown className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">Log downloads</CardTitle>
                  <CardDescription>
                    Raw files behind the live stream: the application log, login log, and ingested
                    reverse proxy access logs.
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={rotateLogs.isPending}
                onClick={() => rotateLogs.mutate()}
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                {rotateLogs.isPending ? "Rotating..." : "Rotate logs"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <ScrollText className="h-4 w-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">
                  <span className="inline-flex items-center gap-2">
                    <StatusLed tone={ledTone} pulse={ledPulse} />
                    Live log stream
                  </span>
                </CardTitle>
                <CardDescription>
                  Streaming from the {activeTab === "login" ? "login" : "application"} log. Newest
                  first; buffer keeps the last 2,000 lines.{" "}
                  <span className="tabular-nums">{activeEntries.length.toLocaleString()} buffered</span>
                  {totalDropped > 0 ? (
                    <span className="tabular-nums">, {totalDropped.toLocaleString()} dropped</span>
                  ) : null}
                </CardDescription>
              </div>
            </div>
          )}
        </CardHeader>
        {activeTab === "downloads" ? (
          <CardContent className="space-y-4">
            {groupedFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {files ? "No log files found." : "Loading downloads..."}
              </p>
            ) : (
              groupedFiles.map((group) => (
                <div key={group.kind} className="space-y-1">
                  <h4 className="text-sm font-medium">{fileKindLabels[group.kind]}</h4>
                  <div className="divide-y rounded-md border">
                    {group.files.map((f) => (
                      <div
                        key={f.name}
                        className="flex flex-wrap items-center justify-between gap-2 p-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{f.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatSize(f.sizeBytes)}
                            {" · "}
                            {f.modifiedAt ? new Date(f.modifiedAt).toLocaleString() : "unknown"}
                            {!f.available ? " · not readable" : ""}
                          </div>
                        </div>
                        {f.available ? (
                          <Button
                            variant="outline"
                            size="sm"
                            asChild
                          >
                            <a
                              href={`/api/v1/logs/files/${f.kind}/${encodeURIComponent(f.name)}`}
                              download
                            >
                              <Download className="mr-1.5 h-3.5 w-3.5" />
                              Download
                            </a>
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled
                          >
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            Download
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        ) : (
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              ref={pauseButtonRef}
              onClick={togglePause}
            >
              {paused ? (
                <>
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {activePending > 0 ? `Resume (${activePending} new)` : "Resume"}
                </>
              ) : (
                <>
                  <Pause className="mr-1.5 h-3.5 w-3.5" />
                  Pause
                </>
              )}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-36 justify-between text-xs"
                >
                  <span className="truncate">{multiSelectLabel(levelFilters, "All levels")}</span>
                  <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-36">
                {LEVELS.map((level) => (
                  <DropdownMenuCheckboxItem
                    key={level}
                    checked={levelFilters.includes(level)}
                    onCheckedChange={() => setLevelFilters((prev) => toggleValue(prev, level))}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {level}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-40 justify-between text-xs"
                >
                  <span className="truncate">
                    {multiSelectLabel(componentFilters, "All components")}
                  </span>
                  <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-40 overflow-y-auto">
                {components.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No components</div>
                ) : (
                  components.map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c}
                      checked={componentFilters.includes(c)}
                      onCheckedChange={() => setComponentFilters((prev) => toggleValue(prev, c))}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {c}
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search message or record..."
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>

          <div ref={wrapperRef} className="min-w-0">
            {filtered.length === 0 ? (
              <p className="flex h-24 items-center justify-center rounded-md border text-center text-sm text-muted-foreground">
                {activeEntries.length === 0
                  ? "Waiting for log lines..."
                  : "No log lines match the current filters."}
              </p>
            ) : (
              <div className="overflow-clip rounded-md border">
                {/* Zero height, so the pill floats over the list without moving it.
                    The box clips rather than hides its overflow: hidden would make
                    it the pill's sticky container, and the pill would scroll away. */}
                <div className="sticky top-2 z-20 flex h-0 justify-center">
                  {!paused && scrolledAway && activePending > 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2 rounded-full shadow-md"
                      onClick={() => {
                        showNewest()
                        // The pill goes away once the lines show; keep keyboard focus in the card.
                        pauseButtonRef.current?.focus({ preventScroll: true })
                      }}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                      {activePending.toLocaleString()} new {activePending === 1 ? "line" : "lines"}
                    </Button>
                  )}
                </div>
                <VirtualTable
                  narrow={narrow}
                  columns={LOG_COLUMNS}
                  rowCount={filtered.length}
                  resetKey={JSON.stringify([activeTab, levelFilters, componentFilters, search])}
                >
                  {!narrow && (
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Time</TableHead>
                        <TableHead className="w-24">Level</TableHead>
                        <TableHead className="w-28">Component</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                  )}
                  <VirtualTableBody
                    key={narrow ? "narrow" : "wide"}
                    rows={filtered}
                    columnCount={narrow ? 1 : LOG_COLUMNS.length}
                    getRowKey={getEntryKey}
                    onAwayFromTopChange={setScrolledAway}
                  >
                    {(entry) => (
                      <LogRow
                        entry={entry}
                        narrow={narrow}
                        onOpenRecord={openRecord}
                        onOpenTraceback={openTraceback}
                      />
                    )}
                  </VirtualTableBody>
                </VirtualTable>
              </div>
            )}
          </div>
        </CardContent>
        )}
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={returnFocus}>
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      "gap-1 uppercase",
                      levelBadgeClasses[selected.level ?? ""] ?? levelBadgeClasses.info,
                    )}
                  >
                    {selected.level ?? "info"}
                  </Badge>
                  {selected.event ?? "Log record"}
                </DialogTitle>
                <DialogDescription>
                  {selected.timestamp ? new Date(selected.timestamp).toLocaleString() : "unknown time"}
                  {selected.logger ? ` · ${selected.logger}` : ""}
                </DialogDescription>
              </DialogHeader>
              <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                <code>{JSON.stringify(selected, null, 2)}</code>
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={tracebackRecord !== null}
        onOpenChange={(open) => !open && setTracebackRecord(null)}
      >
        <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={returnFocus}>
          {tracebackRecord && (
            <>
              <DialogHeader>
                <DialogTitle>Traceback</DialogTitle>
                <DialogDescription>{tracebackRecord.event ?? "Unhandled exception"}</DialogDescription>
              </DialogHeader>
              <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                <code>{tracebackRecord.exception}</code>
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Live log tail for Settings -> Logs: seeded from the tail endpoint, then
 * appended from the /ws/logs stream. Level/component/search filters, a
 * traceback dialog for exceptions, a full-record detail dialog, and a
 * downloads tab for the raw files behind the stream.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
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
  Table,
  TableBody,
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
  nginx: "Nginx access logs",
}
const FILE_KIND_ORDER: LogFileView["kind"][] = ["app", "login", "nginx"]

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
  const pausedRef = useRef(false)
  const pausedBufferRef = useRef<LogRecord[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [totalDropped, setTotalDropped] = useState(0)

  const [levelFilters, setLevelFilters] = useState<string[]>([])
  const [componentFilters, setComponentFilters] = useState<string[]>([])
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput, 200)

  const [selected, setSelected] = useState<LogRecord | null>(null)
  const [tracebackRecord, setTracebackRecord] = useState<LogRecord | null>(null)

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

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

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
    if (paused) {
      const buffered = pausedBufferRef.current
      pausedBufferRef.current = []
      setPendingCount(0)
      setPaused(false)
      if (buffered.length > 0) {
        setEntries((prev) => appendCapped(prev, buffered))
        const loginBuffered = buffered.filter((r) => r.logger === LOGIN_LOGGER_NAME)
        if (loginBuffered.length > 0) {
          setLoginEntries((prev) => appendCapped(prev, loginBuffered))
        }
      }
    } else {
      setPaused(true)
    }
  }

  const activeEntries = activeTab === "login" ? loginEntries : entries

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
      <Card>
        <CardHeader>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "app" | "login" | "downloads")}
          >
            <TabsList className="pointer-coarse:h-10">
              <TabsTrigger value="app">System log</TabsTrigger>
              <TabsTrigger value="login">Login log</TabsTrigger>
              <TabsTrigger value="downloads">Downloads</TabsTrigger>
            </TabsList>
          </Tabs>
          {activeTab === "downloads" ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
                  <FolderDown className="h-4 w-4 text-geo-cyan" />
                </div>
                <div>
                  <CardTitle className="text-base">Log downloads</CardTitle>
                  <CardDescription>
                    Raw files behind the live stream: the application log, login log, and ingested
                    nginx access logs.
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-10"
                disabled={rotateLogs.isPending}
                onClick={() => rotateLogs.mutate()}
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                {rotateLogs.isPending ? "Rotating..." : "Rotate logs"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
                <ScrollText className="h-4 w-4 text-geo-cyan" />
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
                            {formatSize(f.size_bytes)}
                            {" · "}
                            {f.modified_at ? new Date(f.modified_at).toLocaleString() : "unknown"}
                            {!f.available ? " · not readable" : ""}
                          </div>
                        </div>
                        {f.available ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="pointer-coarse:h-10"
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
                            className="pointer-coarse:h-10"
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
              className="pointer-coarse:h-10"
              onClick={togglePause}
            >
              {paused ? (
                <>
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {pendingCount > 0 ? `Resume (${pendingCount} new)` : "Resume"}
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
                  className="h-8 w-36 justify-between text-xs pointer-coarse:h-10"
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
                  className="h-8 w-40 justify-between text-xs pointer-coarse:h-10"
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

          <Table
            className="text-sm"
            containerClassName="max-h-[65vh] overflow-y-auto rounded-md border"
          >
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 z-10 w-24 bg-card">Time</TableHead>
                <TableHead className="sticky top-0 z-10 w-24 bg-card">Level</TableHead>
                <TableHead className="sticky top-0 z-10 w-28 bg-card">Component</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card">Message</TableHead>
                <TableHead className="sticky top-0 z-10 w-10 bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((entry) => {
                const r = entry.record
                const hasTraceback = typeof r.exception === "string" && r.exception.length > 0
                return (
                  <TableRow
                    key={entry.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => setSelected(r)}
                    onKeyDown={(e) => {
                      // Only react when the row itself is the event target: a
                      // native keydown on a nested control (the traceback
                      // button) still bubbles up here even though its click
                      // handler calls stopPropagation, since that only stops
                      // the click event, not this separate keydown binding.
                      if (e.target !== e.currentTarget) return
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        setSelected(r)
                      }
                    }}
                  >
                    <TableCell className="w-24 py-1.5 text-xs tabular-nums text-muted-foreground">
                      <span title={r.timestamp ? new Date(r.timestamp).toLocaleString() : undefined}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "-"}
                      </span>
                    </TableCell>
                    <TableCell className="w-24 py-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "gap-1 uppercase",
                          levelBadgeClasses[r.level ?? ""] ?? levelBadgeClasses.info,
                        )}
                      >
                        {r.level ?? "info"}
                      </Badge>
                    </TableCell>
                    <TableCell className="w-28 py-1.5">
                      <MonoChip>{component(r)}</MonoChip>
                    </TableCell>
                    <TableCell className="w-full max-w-0 py-1.5">
                      {(() => {
                        const context = formatContext(r)
                        const eventText = r.event ?? "(no message)"
                        return (
                          <span
                            className="block truncate font-mono text-xs"
                            title={context ? `${eventText} ${context}` : eventText}
                          >
                            {eventText}
                            {context ? <span className="text-muted-foreground"> {context}</span> : null}
                          </span>
                        )
                      })()}
                    </TableCell>
                    <TableCell className="w-10 py-1.5">
                      {hasTraceback ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="pointer-coarse:h-10"
                          aria-label="View traceback"
                          onClick={(e) => {
                            e.stopPropagation()
                            setTracebackRecord(r)
                          }}
                        >
                          <Layers className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                    {activeEntries.length === 0
                      ? "Waiting for log lines..."
                      : "No log lines match the current filters."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        )}
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-2xl">
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
        <DialogContent className="sm:max-w-2xl">
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

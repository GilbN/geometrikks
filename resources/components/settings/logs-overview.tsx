/**
 * Live log tail for Settings -> Logs: seeded from the tail endpoint, then
 * appended from the /ws/logs stream. Level/component/search filters, a
 * traceback dialog for exceptions, a full-record detail dialog, and a
 * downloads card for the raw files behind the stream.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import {
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
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MonoChip, StatusLed, type LedTone } from "@/components/settings/status-led"
import { useLogFiles, useLogTail } from "@/lib/queries"
import { logStream, type LogRecord, type LogStreamStatus } from "@/lib/logstream"
import type { LogFileView } from "@/generated/api/types.gen"

const MAX_RECORDS = 2000
const FLOW_IDLE_MS = 2000

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
  const { data: files } = useLogFiles()

  const [entries, setEntries] = useState<Entry[]>([])
  const seededRef = useRef(false)
  const nextIdRef = useRef(0)

  const [status, setStatus] = useState<LogStreamStatus>("connecting")
  const [flowing, setFlowing] = useState(false)
  const flowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const pausedBufferRef = useRef<LogRecord[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [totalDropped, setTotalDropped] = useState(0)

  const [levelFilter, setLevelFilter] = useState("all")
  const [componentFilter, setComponentFilter] = useState("all")
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

  // Seed once from the tail backfill; the stream takes over after that.
  useEffect(() => {
    if (tailRecords && !seededRef.current) {
      seededRef.current = true
      setEntries(toEntries([...(tailRecords as LogRecord[])].reverse()))
    }
    // Intentionally seed once: `tailRecords` is a stable staleTime:Infinity
    // query result and toEntries is a plain closure, not a dependency.
  }, [tailRecords])

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
        pausedBufferRef.current = [...pausedBufferRef.current, ...records].slice(-MAX_RECORDS)
        setPendingCount(pausedBufferRef.current.length)
        return
      }

      setEntries((prev) => {
        const merged = [...toEntries([...records].reverse()), ...prev]
        return merged.length > MAX_RECORDS ? merged.slice(0, MAX_RECORDS) : merged
      })
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
        setEntries((prev) => {
          const merged = [...toEntries(buffered.slice().reverse()), ...prev]
          return merged.length > MAX_RECORDS ? merged.slice(0, MAX_RECORDS) : merged
        })
      }
    } else {
      setPaused(true)
    }
  }

  const components = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) set.add(component(e.record))
    return Array.from(set).sort()
  }, [entries])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter((e) => {
      const r = e.record
      if (levelFilter !== "all" && (r.level ?? "") !== levelFilter) return false
      if (componentFilter !== "all" && component(r) !== componentFilter) return false
      if (needle) {
        const eventMatch = r.event?.toLowerCase().includes(needle) ?? false
        if (!eventMatch && !JSON.stringify(r).toLowerCase().includes(needle)) return false
      }
      return true
    })
  }, [entries, levelFilter, componentFilter, search])

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
                Streaming from the application log. Newest first; buffer keeps the last 2,000
                lines. <span className="tabular-nums">{entries.length.toLocaleString()} buffered</span>
                {totalDropped > 0 ? (
                  <span className="tabular-nums">, {totalDropped.toLocaleString()} dropped</span>
                ) : null}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
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

            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger size="sm" className="h-8 w-36 text-xs pointer-coarse:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={componentFilter} onValueChange={setComponentFilter}>
              <SelectTrigger size="sm" className="h-8 w-40 text-xs pointer-coarse:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All components</SelectItem>
                {components.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

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

          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Time</TableHead>
                <TableHead className="w-24">Level</TableHead>
                <TableHead className="w-28">Component</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="w-10" />
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
                        className={cn("gap-1", levelBadgeClasses[r.level ?? ""] ?? levelBadgeClasses.debug)}
                      >
                        {r.level ?? "info"}
                      </Badge>
                    </TableCell>
                    <TableCell className="w-28 py-1.5">
                      <MonoChip>{component(r)}</MonoChip>
                    </TableCell>
                    <TableCell className="w-full max-w-0 py-1.5">
                      <span className="block truncate font-mono text-xs" title={r.event}>
                        {r.event ?? "(no message)"}
                      </span>
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
                    {entries.length === 0
                      ? "Waiting for log lines..."
                      : "No log lines match the current filters."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
              <FolderDown className="h-4 w-4 text-geo-cyan" />
            </div>
            <div>
              <CardTitle className="text-base">Log downloads</CardTitle>
              <CardDescription>
                Raw files behind the stream above: the application log, login log, and ingested
                nginx access logs.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
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
                          <a href={`/api/v1/logs/files/${f.kind}/${encodeURIComponent(f.name)}`} download>
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            Download
                          </a>
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" className="pointer-coarse:h-10" disabled>
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
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-2xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn("gap-1", levelBadgeClasses[selected.level ?? ""] ?? levelBadgeClasses.debug)}
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

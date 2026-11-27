/**
 * Settings > Status on desktop: one card with the verdict on top and a row
 * per component. A row opens to show its detail; a row with a problem opens
 * by itself and moves to the top. boardObserve holds the rules.
 */
import { Children, useCallback, useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleX,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { StatusLed, type LedTone } from "@/components/settings/status-led"
import {
  boardObserve,
  boardToggle,
  isProblemTone,
  type BoardSignal,
  type BoardVerdict,
  type CardState,
  EMPTY_BOARD,
  type VerdictIcon,
} from "@/components/settings/status-logic"
import { cn } from "@/lib/utils"

export interface BoardRowSpec {
  id: string
  icon: React.ComponentType<{ className?: string }>
  name: string
  state: CardState
  /** The one fact that matters, after the state. */
  fact: React.ReactNode
  /** What changes next and when, at the right. */
  end?: React.ReactNode
  /** Whether a problem here makes the verdict Degraded. */
  counts: boolean
  /** False keeps the row closed when it turns into a problem. */
  autoOpen?: boolean
  panel: React.ReactNode
}

const VERDICT_ICONS: Record<VerdictIcon, React.ComponentType<{ className?: string }>> = {
  healthy: CircleCheck,
  warning: TriangleAlert,
  down: CircleX,
  loading: LoaderCircle,
}

const TILE_TONES: Record<LedTone, string> = {
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  red: "bg-red-500/15 text-red-600 dark:text-red-400",
  accent: "bg-primary/15 text-primary",
  muted: "bg-muted text-muted-foreground",
}

const PROBLEM_ROW: Partial<Record<LedTone, string>> = {
  red: "bg-red-500/[0.07]",
  amber: "bg-amber-500/[0.07]",
}

const PROBLEM_ICON: Partial<Record<LedTone, string>> = {
  red: "text-red-600 dark:text-red-500",
  amber: "text-amber-600 dark:text-amber-500",
}

/** Re-renders only itself once a second, so a ticking "in 4s" leaves the
 *  rest of the board alone. */
export function Ticking({ render }: { render: (nowMs: number) => React.ReactNode }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return <>{render(now)}</>
}

export function StatusBoard({
  verdict,
  meta,
  rows,
  onCheckNow,
}: {
  verdict: BoardVerdict
  meta?: React.ReactNode
  rows: readonly BoardRowSpec[]
  onCheckNow: () => Promise<unknown>
}) {
  const signals: BoardSignal[] = rows.map((row) => ({
    id: row.id,
    tone: row.state.tone,
    counts: row.counts,
    autoOpen: row.autoOpen,
  }))
  const signalsKey = signals.map((signal) => `${signal.id}:${signal.tone}`).join(",")
  const signalsRef = useRef(signals)
  signalsRef.current = signals

  const [board, setBoard] = useState(() => boardObserve(EMPTY_BOARD, signals))
  // While the pointer is over the board, or keyboard focus is in it, the rows
  // stay where they are; the latest state applies once it leaves.
  const [pointerInside, setPointerInside] = useState(false)
  const [keyboardInside, setKeyboardInside] = useState(false)
  const held = pointerInside || keyboardInside
  const cardRef = useRef<HTMLDivElement>(null)
  const [applyTick, setApplyTick] = useState(0)
  const appliedTick = useRef(0)
  useEffect(() => {
    const forced = applyTick !== appliedTick.current
    appliedTick.current = applyTick
    if (held && !forced) {
      // A focused node that is removed, or a dialog overlay that unmounts
      // under the pointer, fires no leave event, so check the flags here.
      const card = cardRef.current
      const pointerStale = pointerInside && !card?.matches(":hover")
      const focusStale = keyboardInside && !card?.contains(document.activeElement)
      if (pointerStale) setPointerInside(false)
      if (focusStale) setKeyboardInside(false)
      return
    }
    setBoard((state) => boardObserve(state, signalsRef.current))
  }, [signalsKey, held, applyTick, pointerInside, keyboardInside])

  const [checking, setChecking] = useState(false)
  const checkNow = useCallback(async () => {
    setChecking(true)
    try {
      await onCheckNow()
      // TanStack Query hands fresh data to React on a zero-delay timer, which
      // fires after the refetch promise resolves. Wait for it, so the forced
      // update below sorts the new states and not the old ones.
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      setChecking(false)
      setApplyTick((tick) => tick + 1)
    }
  }, [onCheckNow])

  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = [
    ...board.order.flatMap((id) => byId.get(id) ?? []),
    ...rows.filter((row) => !board.order.includes(row.id)),
  ]
  const VerdictIcon = VERDICT_ICONS[verdict.icon]

  return (
    <Card
      ref={cardRef}
      data-testid="status-board"
      className="@container gap-0 py-0 text-[13px]"
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      // A click inside takes over from the keyboard; the pointer hold covers it.
      onPointerDown={() => setKeyboardInside(false)}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) setKeyboardInside(true)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setKeyboardInside(false)
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-3 px-[18px] py-4">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-[10px]",
            TILE_TONES[verdict.tone],
          )}
        >
          <VerdictIcon
            className={cn(
              "size-[18px]",
              verdict.icon === "loading" && "animate-spin motion-reduce:animate-none",
            )}
          />
        </span>
        <div className="min-w-0">
          {/* Only the label is live, so a poll that changes the counts or the
              time does not announce the verdict again. */}
          <h2 className="text-[15px] font-semibold leading-snug">
            <span role="status">{verdict.label}</span>
          </h2>
          {verdict.detail && <p className="text-muted-foreground">{verdict.detail}</p>}
        </div>
        <span className="flex-1" />
        {meta && <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs aria-disabled:opacity-50"
          // aria-disabled, not disabled: a disabled button drops keyboard focus.
          aria-disabled={checking}
          onClick={() => {
            if (!checking) void checkNow()
          }}
        >
          <RotateCw className={cn(checking && "animate-spin motion-reduce:animate-none")} />
          Check now
        </Button>
      </div>
      <ul aria-label="Components">
        {ordered.map((row) => (
          <BoardRow
            key={row.id}
            row={row}
            open={board.open.includes(row.id)}
            onToggle={() =>
              setBoard((state) => boardToggle(state, row.id, isProblemTone(row.state.tone)))
            }
          />
        ))}
      </ul>
    </Card>
  )
}

function BoardRow({
  row,
  open,
  onToggle,
}: {
  row: BoardRowSpec
  open: boolean
  onToggle: () => void
}) {
  const tone = row.state.tone
  const Icon = row.icon
  return (
    <li className={cn("border-t", PROBLEM_ROW[tone])} data-row={row.id} data-tone={tone}>
      <Collapsible open={open} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="grid min-h-12 w-full grid-cols-[20px_minmax(0,1fr)_minmax(0,1.4fr)_16px] items-center gap-x-3.5 px-[18px] text-left outline-none @2xl:grid-cols-[20px_140px_184px_minmax(0,1fr)_auto_16px] transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <Icon aria-hidden className={cn("size-4", PROBLEM_ICON[tone] ?? "text-primary")} />
            <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
            <span className="flex min-w-0 items-center gap-2">
              <StatusLed tone={tone} />
              <span className="truncate" title={row.state.label}>
                {row.state.label}
              </span>
            </span>
            {/* Hidden on a narrow board, but still part of the row's name. */}
            <span className="sr-only truncate text-muted-foreground @2xl:not-sr-only @2xl:block @2xl:truncate">
              {row.fact}
            </span>
            <span className="hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums @2xl:block">
              {row.end}
            </span>
            <ChevronRight
              aria-hidden
              className={cn(
                "size-[15px] text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-0.5 pr-[18px] pb-[18px] pl-[18px] @2xl:pl-[52px]">
          {row.panel}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** The opened detail of a row: a sentence when the state has one, then cells
 *  and tables on one six-column grid. */
export function BoardPanel({
  sentence,
  children,
}: {
  sentence?: string
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-[10px] bg-background/55 px-4 pt-3.5 pb-3.5 ring-1 ring-border ring-inset">
      {sentence && <p className="mb-3.5 max-w-[62ch]">{sentence}</p>}
      {children}
    </div>
  )
}

export function PanelCaption({ children }: { children: React.ReactNode }) {
  return <p className="mb-2.5 text-xs text-muted-foreground">{children}</p>
}

export function PanelSeparator() {
  return <div aria-hidden className="-mx-4 my-3.5 h-px bg-border" />
}

/** One number per cell on the six-column grid. The cells carry their own
 *  right padding instead of a column gap, so they line up with PanelTable. */
export function Cells({
  children,
  action,
}: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  const count = Children.toArray(children).filter(Boolean).length
  // The action fills the rest of the last line of six; on a narrow board,
  // where the cells wrap, it takes a line of its own.
  const rest = 6 - (count % 6)
  return (
    <div className="grid grid-cols-2 gap-y-3 @md:grid-cols-3 @2xl:grid-cols-6">
      {children}
      {action && (
        <div
          className="col-span-full flex items-end justify-end @2xl:[grid-column:span_var(--rest)/span_var(--rest)]"
          style={{ "--rest": rest } as React.CSSProperties}
        >
          {action}
        </div>
      )}
    </div>
  )
}

export function Cell({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <dl className="min-w-0 pr-4" title={title}>
      <dt className="truncate text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1 truncate text-[15px] font-semibold tabular-nums">{children}</dd>
    </dl>
  )
}

/** A light and a label, for a state inside a panel table. */
export function ToneLabel({ tone, children }: { tone: LedTone; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusLed tone={tone} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

export function PanelLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="tap-area inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
    >
      {children}
      <ArrowRight aria-hidden className="size-[13px]" />
    </Link>
  )
}

export function PanelFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 flex justify-end">{children}</div>
}

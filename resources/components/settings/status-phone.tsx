/**
 * Settings > Status on a phone: one verdict card that lists every problem,
 * then each component as a small tile. A problem or a tile opens a bottom
 * drawer with the full detail, so the verdict, the problems and every
 * component fit on the first screen instead of a stack of tall cards.
 */
import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { StatusLed, type LedTone } from "@/components/settings/status-led"
import type { CardState, StatusProblem } from "@/components/settings/status-logic"
import { cn } from "@/lib/utils"

export interface StatusTile {
  id: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  state: CardState
  /** One short line under the state, e.g. "23.1 MB". */
  sub?: string
  /** The component's full card body, shown in the drawer. */
  body: React.ReactNode
  /** A page with more, linked from the drawer. */
  link?: { to: string; label: string }
}

type Selection = { kind: "problem"; problem: StatusProblem } | { kind: "tile"; tile: StatusTile }

const SEVERITY = { red: "Critical", amber: "Warning" } as const

export function StatusPhone({
  verdict,
  problems,
  tiles,
}: {
  verdict: { tone: LedTone; title: string; detail?: string; meta?: string }
  problems: readonly StatusProblem[]
  tiles: readonly StatusTile[]
}) {
  const [open, setOpen] = useState(false)
  // By id, so an open drawer follows the polled data rather than a copy of it.
  const [selected, setSelected] = useState<{ kind: Selection["kind"]; id: string } | null>(null)
  // The row or tile that opened the drawer gets focus back when it closes.
  const openerRef = useRef<HTMLElement | null>(null)
  const show = (kind: Selection["kind"], id: string, opener: HTMLElement) => {
    openerRef.current = opener
    setSelected({ kind, id })
    setOpen(true)
  }
  const current: Selection | null = (() => {
    if (selected?.kind === "problem") {
      const problem = problems.find((row) => row.id === selected.id)
      return problem ? { kind: "problem", problem } : null
    }
    if (selected?.kind === "tile") {
      const tile = tiles.find((row) => row.id === selected.id)
      return tile ? { kind: "tile", tile } : null
    }
    return null
  })()
  // The last match stays on screen while the drawer slides away.
  const shownRef = useRef<Selection | null>(null)
  if (current) shownRef.current = current
  const selection = current ?? shownRef.current
  // A problem that clears while its drawer is open closes the drawer, rather
  // than leave a fix on screen for something that is no longer wrong.
  const gone = open && selected !== null && current === null
  useEffect(() => {
    if (gone) setOpen(false)
  }, [gone])

  return (
    <div className="space-y-5">
      <Card className="gap-0 py-0">
        <div className="space-y-1 px-4 py-4">
          <div className="flex items-center gap-3">
            <StatusLed tone={verdict.tone} pulse={verdict.tone !== "muted"} />
            <h2 className="text-lg font-semibold leading-tight">{verdict.title}</h2>
          </div>
          {verdict.meta && <p className="pl-5 text-xs text-muted-foreground">{verdict.meta}</p>}
          {problems.length === 0 && verdict.detail && (
            <p className="pl-5 text-sm text-muted-foreground">{verdict.detail}</p>
          )}
        </div>
        {problems.length > 0 && (
          <ul className="border-t border-border/50">
            {problems.map((problem) => (
              <li key={problem.id} className="border-b border-border/50 last:border-b-0">
                <button
                  type="button"
                  onClick={(event) => show("problem", problem.id, event.currentTarget)}
                  className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left"
                >
                  <StatusLed tone={problem.tone} />
                  <span className="min-w-0 flex-1">
                    <span className="sr-only">{SEVERITY[problem.tone]}: </span>
                    <span className="line-clamp-2 text-sm font-medium">{problem.label}</span>
                    {problem.detail && (
                      <span className="block truncate text-xs text-muted-foreground">{problem.detail}</span>
                    )}
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section aria-labelledby="status-components" className="space-y-2">
        <div className="flex items-baseline justify-between px-1">
          <h2 id="status-components" className="text-sm font-semibold">
            Components
          </h2>
          <span className="text-xs text-muted-foreground">Tap one for details</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {tiles.map((tile) => (
            <button
              key={tile.id}
              type="button"
              onClick={(event) => show("tile", tile.id, event.currentTarget)}
              className={cn(
                "flex min-h-24 flex-col gap-1 rounded-xl bg-glass-card p-3 text-left ring-1 shadow-[var(--shadow-card)] backdrop-blur-[2px]",
                tile.state.tone === "red" ? "ring-red-500/50" : "ring-border",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <tile.icon className="size-3.5 shrink-0 text-primary" />
                {tile.title}
              </span>
              <span className="flex items-start gap-2">
                <StatusLed tone={tile.state.tone} className="mt-1.5" />
                <span className="line-clamp-2 text-sm font-medium">{tile.state.label}</span>
              </span>
              {tile.sub && <span className="truncate pl-4 text-xs text-muted-foreground">{tile.sub}</span>}
            </button>
          ))}
        </div>
      </section>

      <Drawer open={open} onOpenChange={setOpen} autoFocus>
        <DrawerContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current?.focus()
          }}
        >
          {selection?.kind === "problem" && <ProblemDetail problem={selection.problem} />}
          {selection?.kind === "tile" && <TileDetail tile={selection.tile} />}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function ProblemDetail({ problem }: { problem: StatusProblem }) {
  return (
    <>
      <DrawerHeader className="group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
        <DrawerTitle className="flex items-start gap-2">
          <StatusLed tone={problem.tone} className="mt-1.5" />
          <span>
            <span className="sr-only">{SEVERITY[problem.tone]}: </span>
            {problem.label}
          </span>
        </DrawerTitle>
        <DrawerDescription className={problem.detail ? undefined : "sr-only"}>
          {problem.detail ?? "A problem GeoMetrikks found with this install."}
        </DrawerDescription>
      </DrawerHeader>
      <div className="flex flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-6">
        {problem.remedy && (
          <code className="block whitespace-pre-line rounded bg-muted px-2 py-1.5 text-xs">{problem.remedy}</code>
        )}
        {problem.docsUrl && (
          <Button asChild variant="outline">
            <a href={problem.docsUrl} target="_blank" rel="noreferrer">
              Setup guide
            </a>
          </Button>
        )}
        {problem.agentName && (
          <Button asChild>
            <Link to="/settings/agents" search={{ instance: problem.agentName }}>
              Open {problem.agentName} on the Agents page
            </Link>
          </Button>
        )}
      </div>
    </>
  )
}

function TileDetail({ tile }: { tile: StatusTile }) {
  return (
    <>
      <DrawerHeader className="group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
        <DrawerTitle className="flex items-center gap-2">
          <tile.icon className="size-4 text-primary" />
          {tile.title}
        </DrawerTitle>
        <DrawerDescription className={tile.description ? undefined : "sr-only"}>
          {tile.description ?? `The state of ${tile.title}.`}
        </DrawerDescription>
      </DrawerHeader>
      <div className="space-y-3 overflow-y-auto overscroll-contain px-4 pb-6">
        {tile.body}
        {tile.link && (
          <Button asChild variant="outline" className="w-full">
            <Link to={tile.link.to}>{tile.link.label}</Link>
          </Button>
        )}
      </div>
    </>
  )
}

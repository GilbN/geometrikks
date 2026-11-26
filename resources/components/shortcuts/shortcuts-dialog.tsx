/** The cheat sheet: every shortcut, in three columns, opened with ? or from the user menu. */
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Dialog as DialogPrimitive } from "radix-ui"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { fetchCrowdsecStatus } from "@/lib/api"
import { queryKeys } from "@/lib/queries"
import { useSingleKeyShortcuts } from "@/lib/shortcut-preference"
import {
  SHORTCUTS,
  shortcutKeyLabels,
  shortcutSpokenKeys,
  type Shortcut,
  type ShortcutGroup,
} from "@/lib/shortcuts"

const GROUPS: { group: ShortcutGroup; title: string }[] = [
  { group: "anywhere", title: "Anywhere" },
  { group: "goto", title: "Go to" },
  { group: "tables", title: "Tables" },
]

const KEY =
  "h-6 min-w-6 rounded-md border border-border bg-transparent px-1.5 text-xs text-foreground"

function Keys({ labels }: { labels: string[] }) {
  return (
    <KbdGroup>
      {labels.map((label, index) => (
        <Kbd key={`${label}-${index}`} className={KEY}>
          {label}
        </Kbd>
      ))}
    </KbdGroup>
  )
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  const paired = SHORTCUTS.find((candidate) => candidate.pairedWith === shortcut.id)
  const labels = [...shortcutKeyLabels(shortcut), ...(paired ? shortcutKeyLabels(paired) : [])]
  const spoken = [
    shortcutSpokenKeys(shortcut).join(" "),
    ...(paired ? [shortcutSpokenKeys(paired).join(" ")] : []),
  ].join(" and ")
  return (
    <li className="flex min-h-7 items-center justify-between gap-3 text-[13px]">
      <span>{shortcut.label}</span>
      <span className="sr-only">: {spoken}</span>
      <span aria-hidden className="shrink-0">
        <Keys labels={labels} />
      </span>
    </li>
  )
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [singleKeys] = useSingleKeyShortcuts()
  const { data: crowdsec } = useQuery({
    queryKey: queryKeys.crowdsec.status,
    queryFn: fetchCrowdsecStatus,
    staleTime: 60_000,
    enabled: open,
  })
  const shown = (shortcut: Shortcut) =>
    shortcut.id !== "cheat-sheet" &&
    !shortcut.pairedWith &&
    (shortcut.id !== "ban" || crowdsec?.writeEnabled === true)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto p-7 outline-none sm:max-w-[760px]"
        // The list has nothing to act on, so open without a focus ring on Esc.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement).focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="gap-1.5">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="text-lg font-semibold">Keyboard shortcuts</DialogTitle>
            <DialogPrimitive.Close
              className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label="Close"
            >
              <Kbd className={KEY}>Esc</Kbd>
            </DialogPrimitive.Close>
          </div>
          <DialogDescription className="text-sm">
            {singleKeys ? (
              <>
                Press <Kbd className={KEY}>?</Kbd> on any page to see this list.
              </>
            ) : (
              <>
                Single-key shortcuts are off. Turn them on in{" "}
                <Link
                  to="/settings/appearance"
                  className="text-foreground underline underline-offset-2"
                  onClick={() => onOpenChange(false)}
                >
                  Settings, Appearance
                </Link>
                .
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-3">
          {GROUPS.map(({ group, title }) => (
            <section key={group} aria-label={title} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {title}
              </h3>
              <ul className="space-y-0.5">
                {SHORTCUTS.filter((shortcut) => shortcut.group === group && shown(shortcut)).map(
                  (shortcut) => (
                    <ShortcutRow key={shortcut.id} shortcut={shortcut} />
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

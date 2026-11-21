import { useRef, useState } from "react"
import { EyeOff, X } from "lucide-react"
import { toast } from "sonner"
import type { MutedIpView } from "@/generated/api/types.gen"
import { useAddMutedIp, useMutedIpsList, useRemoveMutedIp } from "@/lib/queries"
import {
  focusIdAfterRemoval,
  mutedIpCodeOf,
  mutedIpErrorMessage,
  mutedIpsCountLine,
  runUnmute,
} from "@/lib/muted-ips"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MonoChip } from "@/components/settings/status-led"
import { timeAgo } from "@/components/settings/api-keys-logic"
import { MUTED_IPS_DOCS_URL } from "@/lib/docs-links"

const NOTE_MAX_LENGTH = 100

function AddMutedIpForm() {
  const [network, setNetwork] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const addMutedIp = useAddMutedIp()
  const pending = addMutedIp.isPending

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmedNetwork = network.trim()
        if (!trimmedNetwork || pending) return
        setError(null)
        const trimmedNote = note.trim()
        addMutedIp.mutate(
          { network: trimmedNetwork, note: trimmedNote || null },
          {
            onSuccess: (created) => {
              setNetwork("")
              setNote("")
              toast.success(`Muted ${created.network}`)
            },
            onError: (mutationError) => setError(mutedIpErrorMessage(mutedIpCodeOf(mutationError))),
          },
        )
      }}
    >
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          value={network}
          onChange={(event) => {
            setNetwork(event.target.value)
            setError(null)
          }}
          readOnly={pending}
          placeholder="IP or CIDR, such as 203.0.113.7 or 10.0.0.0/8"
          aria-label="IP or CIDR"
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className="font-mono md:flex-[3]"
        />
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          readOnly={pending}
          placeholder="Note (optional)"
          aria-label="Note"
          maxLength={NOTE_MAX_LENGTH}
          autoComplete="off"
          className="md:flex-[2]"
        />
        <Button type="submit" disabled={pending || !network.trim()}>
          Mute
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

type UnmuteControls = {
  pendingIds: ReadonlySet<string>
  unmute: (entry: MutedIpView) => void
}

function UnmuteButton({ entry, controls }: { entry: MutedIpView; controls: UnmuteControls }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-unmute-id={entry.id}
      aria-label={`Unmute ${entry.network}`}
      disabled={controls.pendingIds.has(entry.id)}
      onClick={() => controls.unmute(entry)}
    >
      <X aria-hidden />
    </Button>
  )
}

export function MutedIpsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <EyeOff aria-hidden className="size-5 text-muted-foreground" />
      <p className="max-w-md text-sm text-muted-foreground">
        No muted IPs yet. Add one above, or use Mute IP from a row&apos;s IP menu on Access Logs,
        Geo Logs or Analytics.
      </p>
    </div>
  )
}

function MutedIpsTable({
  entries,
  now,
  controls,
}: {
  entries: MutedIpView[]
  now: number
  controls: UnmuteControls
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Network</TableHead>
          <TableHead>Note</TableHead>
          <TableHead>Added</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>
              <MonoChip>{entry.network}</MonoChip>
            </TableCell>
            <TableCell className="max-w-xs whitespace-normal break-words text-muted-foreground">
              {entry.note ?? ""}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {timeAgo(now - Date.parse(entry.createdAt))}
            </TableCell>
            <TableCell className="text-right">
              <UnmuteButton entry={entry} controls={controls} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function MutedIpsRows({
  entries,
  now,
  controls,
}: {
  entries: MutedIpView[]
  now: number
  controls: UnmuteControls
}) {
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1">
            <MonoChip className="break-all">{entry.network}</MonoChip>
            {entry.note && (
              <span className="mt-1 block text-xs break-words text-muted-foreground">
                {entry.note}
              </span>
            )}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {timeAgo(now - Date.parse(entry.createdAt))}
            </span>
          </span>
          <UnmuteButton entry={entry} controls={controls} />
        </li>
      ))}
    </ul>
  )
}

export function MutedIpsOverview({ narrow }: { narrow: boolean }) {
  const { data, isError, isPending } = useMutedIpsList(30_000)
  const now = Date.now()
  const cardRef = useRef<HTMLDivElement>(null)
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const removeMutedIp = useRemoveMutedIp()

  const unmute = async (entry: MutedIpView) => {
    if (pendingIds.has(entry.id)) return
    const nextId = focusIdAfterRemoval(data?.map((row) => row.id) ?? [], entry.id)
    setPendingIds((ids) => new Set(ids).add(entry.id))
    const result = await runUnmute(removeMutedIp.mutateAsync, entry.id)
    setPendingIds((ids) => {
      const next = new Set(ids)
      next.delete(entry.id)
      return next
    })
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success(`Unmuted ${entry.network}`)
    const target = nextId
      ? cardRef.current?.querySelector<HTMLElement>(`[data-unmute-id="${CSS.escape(nextId)}"]`)
      : null
    ;(target ?? cardRef.current)?.focus()
  }
  const controls: UnmuteControls = { pendingIds, unmute }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <AddMutedIpForm />
          <a
            href={MUTED_IPS_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="tap-area inline-block text-xs text-primary underline underline-offset-2"
          >
            How this differs from LOGPARSER_IGNORE_IPS
          </a>
        </CardContent>
      </Card>
      <Card ref={cardRef} tabIndex={-1} aria-label="Muted IPs" className="gap-0 py-0 outline-none">
        {isPending ? (
          <CardContent className="py-4">
            <Skeleton className="h-24 w-full" />
          </CardContent>
        ) : isError || !data ? (
          <CardContent className="py-4 text-sm text-muted-foreground">
            Couldn&apos;t load the muted IPs. Try again shortly.
          </CardContent>
        ) : data.length === 0 ? (
          <MutedIpsEmptyState />
        ) : (
          <>
            <p className="px-4 pt-3 pb-1 text-xs md:px-2 text-muted-foreground">
              {mutedIpsCountLine(data.length)}
            </p>
            {narrow ? (
              <MutedIpsRows entries={data} now={now} controls={controls} />
            ) : (
              <MutedIpsTable entries={data} now={now} controls={controls} />
            )}
          </>
        )}
      </Card>
    </div>
  )
}

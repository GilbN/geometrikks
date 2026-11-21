import { useState } from "react"
import { EyeOff, X } from "lucide-react"
import { toast } from "sonner"
import type { MutedIpView } from "@/generated/api/types.gen"
import { useAddMutedIp, useMutedIpsList, useRemoveMutedIp } from "@/lib/queries"
import { mutedIpCodeOf, mutedIpErrorMessage, mutedIpsCountLine } from "@/lib/muted-ips"
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
          onChange={(event) => setNetwork(event.target.value)}
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

function useUnmute() {
  const removeMutedIp = useRemoveMutedIp()
  return (entry: MutedIpView) =>
    removeMutedIp.mutate(entry.id, {
      onSuccess: () => toast.success(`Unmuted ${entry.network}`),
      onError: (error) => toast.error(mutedIpErrorMessage(mutedIpCodeOf(error))),
    })
}

function UnmuteButton({ entry, onUnmute }: { entry: MutedIpView; onUnmute: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Unmute ${entry.network}`}
      onClick={onUnmute}
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

function MutedIpsTable({ entries, now }: { entries: MutedIpView[]; now: number }) {
  const unmute = useUnmute()
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
            <TableCell className="text-muted-foreground">{entry.note ?? ""}</TableCell>
            <TableCell className="text-muted-foreground">
              {timeAgo(now - Date.parse(entry.createdAt))}
            </TableCell>
            <TableCell className="text-right">
              <UnmuteButton entry={entry} onUnmute={() => unmute(entry)} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function MutedIpsRows({ entries, now }: { entries: MutedIpView[]; now: number }) {
  const unmute = useUnmute()
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1">
            <MonoChip>{entry.network}</MonoChip>
            {entry.note && (
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {entry.note}
              </span>
            )}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {timeAgo(now - Date.parse(entry.createdAt))}
            </span>
          </span>
          <UnmuteButton entry={entry} onUnmute={() => unmute(entry)} />
        </li>
      ))}
    </ul>
  )
}

export function MutedIpsOverview({ narrow }: { narrow: boolean }) {
  const { data, isError, isPending } = useMutedIpsList(30_000)
  const now = Date.now()

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
      <Card>
        {isPending ? (
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        ) : isError || !data ? (
          <CardContent className="text-sm text-muted-foreground">
            Couldn&apos;t load the muted IPs. Try again shortly.
          </CardContent>
        ) : data.length === 0 ? (
          <MutedIpsEmptyState />
        ) : (
          <>
            <p className="px-4 pt-1 text-xs text-muted-foreground">
              {mutedIpsCountLine(data.length)}
            </p>
            {narrow ? (
              <MutedIpsRows entries={data} now={now} />
            ) : (
              <MutedIpsTable entries={data} now={now} />
            )}
          </>
        )}
      </Card>
    </div>
  )
}

/**
 * "DROP networks in your traffic" on the Security page: every DROP-listed
 * network that sent requests in the range, busiest first, with its Range
 * decision, a per-row ban and a bulk ban of every unbanned network.
 */
import { type Ref, useCallback, useEffect, useRef, useState } from "react"
import { useLocation } from "@tanstack/react-router"
import { ChevronDown, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TABLE_PAGE_SIZE, TablePaginationFooter } from "@/components/analytics/table-pagination"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { useFitLayout } from "@/components/data/narrow-layout"
import { DropCredit } from "@/components/drop/drop-credit"
import type { BanNetworkResult, BanNetworksResponse, DropNetworkTrafficView } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"
import { BAN_DURATIONS, crowdsecErrorMessage } from "@/lib/crowdsec"
import { dropBanReason, dropNetworkBannedText, dropNetworksLoaded } from "@/lib/drop-lists"
import {
  DROP_NETWORK_RANGES,
  DROP_NETWORKS_STALE_NOTE,
  bulkBanConfirmText,
  counted,
  bulkBanLeftOutText,
  bulkBanResultCounts,
  bulkBanResultText,
  dropLastSeenText,
  dropNetworkFreshness,
  dropNetworkPhoneText,
  dropNetworksSummary,
  focusTarget,
  rangeDecisionText,
  sortedBanResults,
  unbannedNetworkCount,
  type DropNetworkRange,
} from "@/lib/drop-networks"
import { useAbout, useBanDropNetworks, useBanIp, useCrowdsecStatus, useDropNetworks } from "@/lib/queries"
import { cn } from "@/lib/utils"

export const DROP_NETWORKS_CARD_ID = "drop-networks"

type BanDuration = (typeof BAN_DURATIONS)[number]

const BAN_BUTTON_CLASS =
  "border-destructive/50 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive aria-expanded:bg-destructive/10 aria-expanded:text-destructive dark:border-destructive/50 dark:bg-transparent dark:hover:bg-destructive/15"

export function DropNetworksCard() {
  const { data: about } = useAbout()
  const listsLoaded = about?.dropLists?.enabled === true && dropNetworksLoaded(about.dropLists)
  if (!listsLoaded) return null
  return <DropNetworksCardBody />
}

function DropNetworksCardBody() {
  const { data: status } = useCrowdsecStatus()
  const { data: about } = useAbout()
  const [days, setDays] = useState<DropNetworkRange>(30)
  const [page, setPage] = useState(1)
  const { data, isError, isPlaceholderData } = useDropNetworks({ days, page, pageSize: TABLE_PAGE_SIZE })
  const cardRef = useScrollToCardOnArrival(data !== undefined)
  const bulkBanButtonRef = useRef<HTMLButtonElement>(null)
  const [bulkBanDuration, setBulkBanDuration] = useState<BanDuration | null>(null)

  const rowsKey = `${days}:${page}:${data?.items.map((dropNetwork) => dropNetwork.cidr).join(",") ?? ""}`
  const [layoutRef, narrow] = useFitLayout<HTMLDivElement>(rowsKey)
  const setCardElement = useCallback(
    (element: HTMLDivElement | null) => {
      cardRef.current = element
      layoutRef(element)
    },
    [cardRef, layoutRef],
  )

  if (data && !data.loaded) return null

  const total = data?.totalNetworks ?? 0
  const pageCount = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE))
  if (data && !isPlaceholderData && page > pageCount) setPage(pageCount)

  const decisionsAvailable = data?.decisionsAvailable ?? true
  const banControls = status?.writeEnabled === true && decisionsAvailable
  const unbannedCount = data ? unbannedNetworkCount(data) : 0
  const summary = data ? dropNetworksSummary(data) : null
  const freshness = dropNetworkFreshness(about?.dropLists)

  return (
    <Card
      id={DROP_NETWORKS_CARD_ID}
      ref={setCardElement}
      tabIndex={-1}
      className="scroll-mt-4 py-4 outline-none"
    >
      <CardHeader className="flex flex-row flex-wrap items-center gap-x-3 gap-y-2 pb-1">
        <CardTitle className="mr-auto text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          DROP networks in your traffic · last {days} days
        </CardTitle>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Range"
          value={String(days)}
          onValueChange={(value) => {
            if (!value) return
            setDays(Number(value) as DropNetworkRange)
            setPage(1)
          }}
        >
          {DROP_NETWORK_RANGES.map((range) => (
            <ToggleGroupItem key={range} value={String(range)} className="px-2.5 text-xs">
              {range} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {summary ? (
            <p className={cn("mr-auto min-w-0", isPlaceholderData && "opacity-60")}>
              <span className="text-xl font-semibold tabular-nums">{summary.networks}</span>{" "}
              <span className="text-sm text-muted-foreground">{summary.detail}</span>
            </p>
          ) : (
            <Skeleton className="mr-auto h-7 w-72 max-w-full" />
          )}
          {banControls && data && (
            <BulkBanMenu
              ref={bulkBanButtonRef}
              disabled={isPlaceholderData || unbannedCount === 0}
              onChoose={setBulkBanDuration}
            />
          )}
        </div>
        {/* The refresh after a bulk ban can find the LAPI down and drop the menu,
            so the dialog with the results sits outside the banControls gate. */}
        <BulkBanDialog
          days={days}
          unbannedCount={unbannedCount}
          duration={bulkBanDuration}
          onClose={() => setBulkBanDuration(null)}
          focusOnClose={() => focusTarget([bulkBanButtonRef.current, cardRef.current])}
        />
        {data && !decisionsAvailable && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            CrowdSec could not be reached, so ban status is unknown.
          </p>
        )}
        <div className="overflow-x-auto">
          <Table className={narrow ? "table-fixed" : undefined}>
            {!narrow && (
              <TableHeader>
                <TableRow>
                  <TableHead>Network</TableHead>
                  <TableHead>SBL</TableHead>
                  <TableHead>ASN</TableHead>
                  <TableHead className="text-right">Hits</TableHead>
                  <TableHead className="text-right">IPs</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
            )}
            <TableBody className={cn(isPlaceholderData && "opacity-60")}>
              {!data && !isError &&
                Array.from({ length: 5 }).map((_, rowIndex) => (
                  <TableRow key={rowIndex}>
                    <TableCell colSpan={narrow ? 1 : 7}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {!data && isError && (
                <TableRow>
                  <TableCell colSpan={narrow ? 1 : 7} className="h-20 text-center text-destructive">
                    Failed to load DROP network traffic. It will retry automatically.
                  </TableCell>
                </TableRow>
              )}
              {data && data.items.length === 0 && !isPlaceholderData && (
                <TableRow>
                  <TableCell colSpan={narrow ? 1 : 7} className="h-20 text-center text-muted-foreground">
                    No traffic from DROP networks in this range.
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map((dropNetwork) => (
                <DropNetworkRow
                  key={dropNetwork.cidr}
                  dropNetwork={dropNetwork}
                  narrow={narrow}
                  banControls={banControls}
                  decisionsAvailable={decisionsAvailable}
                />
              ))}
            </TableBody>
          </Table>
        </div>
        <TablePaginationFooter page={page} pageCount={pageCount} total={total} pageSize={TABLE_PAGE_SIZE} onPageChange={setPage} />
        <DropCredit updatedAt={freshness.updatedAt} stale={freshness.stale} staleNote={DROP_NETWORKS_STALE_NOTE} />
      </CardContent>
    </Card>
  )
}

/**
 * The router scrolls to a hash on navigation, before this card exists: the
 * page waits for the CrowdSec status and the card for the About answer. So
 * the card scrolls itself into view when it mounts and once more when its
 * rows land, which can move it.
 */
function useScrollToCardOnArrival(hasRows: boolean) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hash = useLocation({ select: (location) => location.hash })
  const scrolledWithRows = useRef(false)
  useEffect(() => {
    if (hash !== DROP_NETWORKS_CARD_ID || scrolledWithRows.current) return
    cardRef.current?.scrollIntoView({ block: "start" })
    if (hasRows) scrolledWithRows.current = true
  }, [hash, hasRows])
  return cardRef
}

function DropNetworkRow({
  dropNetwork,
  narrow,
  banControls,
  decisionsAvailable,
}: {
  dropNetwork: DropNetworkTrafficView
  narrow: boolean
  banControls: boolean
  decisionsAvailable: boolean
}) {
  const asnText = dropNetwork.asn === null ? null : `AS${dropNetwork.asn}`
  const status = <NetworkStatus dropNetwork={dropNetwork} banControls={banControls} decisionsAvailable={decisionsAvailable} />
  const lastSeen = dropLastSeenText(dropNetwork.lastSeen)

  if (narrow) {
    const hitsText = `${counted(dropNetwork.hits, "hit", "hits")} · ${lastSeen}`
    return (
      <TableRow>
        <TableCell className="py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 font-mono [overflow-wrap:anywhere] whitespace-normal">{dropNetwork.cidr}</span>
            <span className="ml-auto flex shrink-0 items-center">{status}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0 whitespace-nowrap tabular-nums">{dropNetworkPhoneText(dropNetwork)}</span>
            <span className="ml-auto min-w-0 truncate tabular-nums" title={hitsText}>
              {hitsText}
            </span>
          </div>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <TableRow>
      <TableCell className="font-mono">{dropNetwork.cidr}</TableCell>
      <TableCell className="font-mono text-muted-foreground">{dropNetwork.sblId}</TableCell>
      <TableCell className="max-w-[16rem] truncate" title={dropNetwork.asOrg ?? undefined}>
        {asnText ? (
          <>
            <span className="font-mono">{asnText}</span> {dropNetwork.asOrg}
          </>
        ) : (
          "-"
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(dropNetwork.hits)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(dropNetwork.ips)}</TableCell>
      <TableCell className="whitespace-nowrap">{lastSeen}</TableCell>
      <TableCell>{status}</TableCell>
    </TableRow>
  )
}

function NetworkStatus({
  dropNetwork,
  banControls,
  decisionsAvailable,
}: {
  dropNetwork: DropNetworkTrafficView
  banControls: boolean
  decisionsAvailable: boolean
}) {
  if (!decisionsAvailable) {
    return <span className="text-xs text-muted-foreground">Unknown</span>
  }
  if (dropNetwork.decision) {
    return (
      <DecisionBadge
        type={dropNetwork.decision.type}
        title={`Active CrowdSec ${dropNetwork.decision.type} decision on ${dropNetwork.cidr}`}
        className="whitespace-nowrap"
      >
        {rangeDecisionText(dropNetwork.decision)}
      </DecisionBadge>
    )
  }
  if (!banControls) return <span className="text-xs text-muted-foreground">Not banned</span>
  return <RowBanMenu dropNetwork={dropNetwork} />
}

function RowBanMenu({ dropNetwork }: { dropNetwork: DropNetworkTrafficView }) {
  const banNetwork = useBanIp()
  const { cidr } = dropNetwork
  const ban = (duration: BanDuration) => {
    // mutate's own callbacks never run once the refresh after the ban
    // unmounts this menu, so the toasts hang off mutateAsync.
    banNetwork
      .mutateAsync({ ip: cidr, duration: duration.value, reason: dropBanReason(dropNetwork.sblId) })
      .then(
        () => toast.success(dropNetworkBannedText(cidr, duration.label)),
        (error: unknown) =>
          toast.error(crowdsecErrorMessage(error, `Ban failed for ${cidr}; the LAPI may be unreachable.`)),
      )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={BAN_BUTTON_CLASS}
          disabled={banNetwork.isPending}
          aria-label={`Ban DROP network ${cidr} for…`}
        >
          {banNetwork.isPending ? <Loader2 className="animate-spin" /> : null}
          Ban for…
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-mono text-xs">{cidr}</DropdownMenuLabel>
        {BAN_DURATIONS.map((duration) => (
          <DropdownMenuItem key={duration.value} onSelect={() => ban(duration)}>
            {duration.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type BulkBanOutcome = { response: BanNetworksResponse; durationLabel: string }

function BulkBanMenu({
  ref,
  disabled,
  onChoose,
}: {
  ref: Ref<HTMLButtonElement>
  disabled: boolean
  onChoose: (duration: BanDuration) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={ref} variant="outline" size="sm" className={BAN_BUTTON_CLASS} disabled={disabled}>
          Ban all unbanned for…
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {BAN_DURATIONS.map((duration) => (
          <DropdownMenuItem key={duration.value} onSelect={() => onChoose(duration)}>
            {duration.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BulkBanDialog({
  days,
  unbannedCount,
  duration,
  onClose,
  focusOnClose,
}: {
  days: DropNetworkRange
  unbannedCount: number
  duration: BanDuration | null
  onClose: () => void
  focusOnClose: () => HTMLElement | null
}) {
  const banNetworks = useBanDropNetworks()
  const [outcome, setOutcome] = useState<BulkBanOutcome | null>(null)

  const close = () => {
    if (banNetworks.isPending) return
    onClose()
    setOutcome(null)
  }

  const confirm = () => {
    if (!duration) return
    banNetworks.mutateAsync({ allUnbannedDays: days, duration: duration.value }).then(
      (response) => setOutcome({ response, durationLabel: duration.label }),
      (error: unknown) => {
        toast.error(crowdsecErrorMessage(error, "The bulk ban failed; the LAPI may be unreachable."))
        onClose()
      },
    )
  }

  return (
    <AlertDialog open={duration !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          const target = focusOnClose()
          if (!target) return
          event.preventDefault()
          target.focus()
        }}
      >
        {outcome ? (
          <BulkBanOutcomeView outcome={outcome} onDone={close} />
        ) : (
          duration && (
            <BulkBanConfirm
              text={bulkBanConfirmText(unbannedCount, duration.label, days)}
              pending={banNetworks.isPending}
              onConfirm={confirm}
            />
          )
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BulkBanConfirm({
  text,
  pending,
  onConfirm,
}: {
  text: { title: string; description: string }
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{text.title}</AlertDialogTitle>
        <AlertDialogDescription>{text.description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
        {/* Not an AlertDialogAction, which would close the dialog before the results arrive. */}
        <Button variant="destructive" disabled={pending} onClick={onConfirm}>
          {pending && <Loader2 className="animate-spin" />}
          {pending ? "Banning…" : "Ban networks"}
        </Button>
      </AlertDialogFooter>
    </>
  )
}

function BulkBanOutcomeView({ outcome, onDone }: { outcome: BulkBanOutcome; onDone: () => void }) {
  const { response, durationLabel } = outcome
  const counts = bulkBanResultCounts(response.results)
  const leftOutText = bulkBanLeftOutText(response.leftOut)
  const banResults = sortedBanResults(response.results)
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{counts.failed > 0 ? "Some bans failed" : "Networks banned"}</AlertDialogTitle>
        <AlertDialogDescription>{bulkBanResultText(counts, durationLabel)}</AlertDialogDescription>
      </AlertDialogHeader>
      {leftOutText && <p className="text-center text-sm text-amber-600 sm:text-left dark:text-amber-400">{leftOutText}</p>}
      {banResults.length > 0 && (
        <ul className="max-h-60 overflow-y-auto rounded-md border text-sm" aria-label="Result per network">
          {banResults.map((banResult) => (
            <li key={banResult.network} className="flex flex-wrap items-baseline gap-x-3 border-b px-3 py-1.5 last:border-b-0">
              <span className="font-mono">{banResult.network}</span>
              <BanResultText banResult={banResult} />
            </li>
          ))}
        </ul>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel onClick={onDone}>Done</AlertDialogCancel>
      </AlertDialogFooter>
    </>
  )
}

function BanResultText({ banResult }: { banResult: BanNetworkResult }) {
  if (!banResult.ok) {
    return <span className="ml-auto text-right text-destructive">{banResult.error ?? "Failed"}</span>
  }
  return (
    <span className="ml-auto text-muted-foreground">{banResult.alreadyBanned ? "Already banned" : "Banned"}</span>
  )
}

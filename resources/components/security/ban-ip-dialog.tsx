/**
 * Form for a manual decision on any IP or CIDR range, with ban or captcha,
 * a preset or custom duration, and a reason. It validates before sending,
 * and the server validates again and normalizes the range and duration.
 */
import { useState } from "react"
import { Loader2, ShieldBan } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useBanIp } from "@/lib/queries"
import {
  BAN_DURATIONS,
  DECISION_TYPES,
  crowdsecErrorMessage,
  isValidBanDuration,
  isValidBanTarget,
  rangeSizeLabel,
  type BanDecisionType,
} from "@/lib/crowdsec"

const CUSTOM_DURATION = "custom"

function BanIpForm({ initialIp, onDone }: { initialIp: string; onDone: () => void }) {
  const [ip, setIp] = useState(initialIp)
  const [type, setType] = useState<BanDecisionType>("ban")
  const [preset, setPreset] = useState<string>("4h")
  const [customDuration, setCustomDuration] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const ban = useBanIp()
  const rangeSize = rangeSizeLabel(ip.trim())

  const submit = () => {
    const target = ip.trim()
    if (!isValidBanTarget(target)) {
      setError("Enter a full IPv4 or IPv6 address, or a range such as 203.0.113.0/24.")
      return
    }
    const duration = preset === CUSTOM_DURATION ? customDuration.trim() : preset
    if (!isValidBanDuration(duration)) {
      setError("Enter a duration such as 90m, 12h, 3d or 1d12h.")
      return
    }
    setError(null)
    ban.mutate(
      { ip: target, duration, reason: reason.trim() || undefined, type },
      {
        onSuccess: onDone,
        onError: (err) => {
          setError(crowdsecErrorMessage(err, "Ban failed; the LAPI may be unreachable."))
        },
      },
    )
  }

  const submitOnEnter = (event: React.KeyboardEvent) => event.key === "Enter" && submit()

  return (
    <>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ban-ip">IP address or range</Label>
          <Input
            id="ban-ip"
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            onKeyDown={submitOnEnter}
            placeholder="203.0.113.7 or 203.0.113.0/24"
            className="font-mono"
          />
          {rangeSize && <p className="text-xs text-muted-foreground">Covers {rangeSize}.</p>}
        </div>
        <div className="space-y-1.5">
          <Label>Decision</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={type}
            onValueChange={(value) => value && setType(value as BanDecisionType)}
          >
            {DECISION_TYPES.map((d) => (
              <ToggleGroupItem key={d.value} value={d.value}>
                {d.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {type === "captcha" && (
            <p className="text-xs text-muted-foreground">
              Only bouncers with captcha configured can serve one.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ban-duration">Duration</Label>
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger id="ban-duration" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BAN_DURATIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_DURATION}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {preset === CUSTOM_DURATION && (
            <Input
              aria-label="Custom duration"
              value={customDuration}
              onChange={(event) => setCustomDuration(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="90m, 12h, 3d, 1d12h"
              className="font-mono"
              autoFocus
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ban-reason">Reason (optional)</Label>
          <Input
            id="ban-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={submitOnEnter}
            placeholder={`manual ${type} from GeoMetrikks`}
            maxLength={200}
          />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={ban.isPending || !ip.trim()}>
          {ban.isPending && <Loader2 data-icon="inline-start" className="animate-spin" />}
          {type === "ban" ? "Ban" : "Require captcha"}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Controlled so the row and popup ban menus can open it prefilled. */
export function BanIpDialog({
  open,
  onOpenChange,
  initialIp = "",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialIp?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Ban an IP or range</DialogTitle>
          <DialogDescription>
            Creates a manual CrowdSec decision with origin geometrikks.
            Your bouncer enforces it.
          </DialogDescription>
        </DialogHeader>
        <BanIpForm initialIp={initialIp} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

export function BanIpButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ShieldBan data-icon="inline-start" />
        Ban IP
      </Button>
      <BanIpDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

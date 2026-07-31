/**
 * Manual ban form: any IP, not just ones visible in a table. Validates
 * client-side before the request; the server re-validates against INET.
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
  DialogTrigger,
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
import { useBanIp } from "@/lib/queries"
import { BAN_DURATIONS, crowdsecErrorMessage, isValidIp } from "@/lib/crowdsec"

export function BanIpDialog() {
  const [open, setOpen] = useState(false)
  const [ip, setIp] = useState("")
  const [duration, setDuration] = useState<string>("4h")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const ban = useBanIp()

  const reset = () => {
    setIp("")
    setDuration("4h")
    setReason("")
    setError(null)
    ban.reset()
  }

  const submit = () => {
    const trimmed = ip.trim()
    if (!isValidIp(trimmed)) {
      setError("Enter a full IPv4 or IPv6 address.")
      return
    }
    setError(null)
    ban.mutate(
      { ip: trimmed, duration, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setOpen(false)
          reset()
        },
        onError: (err) => {
          setError(crowdsecErrorMessage(err, "Ban failed; the LAPI may be unreachable."))
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldBan data-icon="inline-start" />
          Ban IP
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Ban an IP</DialogTitle>
          <DialogDescription>
            Creates a manual CrowdSec ban decision (origin geometrikks).
            Enforcement happens through your bouncer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ban-ip">IP address</Label>
            <Input
              id="ban-ip"
              value={ip}
              onChange={(event) => setIp(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
              placeholder="203.0.113.7"
              className="font-mono"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ban-reason">Reason (optional)</Label>
            <Input
              id="ban-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
              placeholder="manual ban from GeoMetrikks"
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Duration</Label>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BAN_DURATIONS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={ban.isPending || !ip.trim()}>
            {ban.isPending && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Ban {duration ? BAN_DURATIONS.find((d) => d.value === duration)?.label.toLowerCase() : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

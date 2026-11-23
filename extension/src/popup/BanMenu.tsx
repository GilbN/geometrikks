import { ChevronDown, Loader2, ShieldBan } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { BAN_DURATIONS } from "@/lib/crowdsec"
import type { BanDuration } from "../lib/actions"

export function BanMenu({
  ip,
  busy,
  onBan,
}: {
  ip: string
  busy: boolean
  onBan: (duration: BanDuration) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="destructive" className="h-8 flex-1 text-[12.5px]" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldBan />}
          Ban
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[170px]">
        <DropdownMenuLabel className="pt-1 pb-0.5 text-[11px] font-normal">
          Ban <span className="font-mono">{ip}</span> for
        </DropdownMenuLabel>
        {BAN_DURATIONS.map((duration) => (
          <DropdownMenuItem
            key={duration.value}
            className="text-[12.5px]"
            onSelect={() => onBan(duration)}
          >
            {duration.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function AlertKindHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="What the alert kinds mean">
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="What the alert kinds mean" className="w-80 text-sm">
        <p>
          <strong>Log scenarios.</strong> A scenario overflowed on events from your logs. This includes the bot
          challenge&apos;s ban scenarios. Most bans come from here.
        </p>
        <p>
          <strong>WAF.</strong> The AppSec engine matched a request against a rule, such as a virtual patch. Every
          match is its own alert, and many never ban.
        </p>
        <p>
          <strong>Bot detection.</strong> The AppSec bot challenge. A rejected browser submission is logged as an
          alert and never bans. Repeated failures raise a bot ban.
        </p>
        <p className="text-muted-foreground">Filtering by kind needs CrowdSec 1.7 or newer.</p>
      </PopoverContent>
    </Popover>
  )
}

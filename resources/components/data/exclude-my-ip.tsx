/** The phone button that excludes the viewer's own IP on the log pages. useMyIpExclusion supplies its state. */
import { UserX } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { MyIpExclusion } from "@/lib/my-ip-exclusion"
import { cn } from "@/lib/utils"

const EXCLUDED_BUTTON =
  "border-destructive/50 text-destructive hover:text-destructive dark:border-destructive/50"

export const UNTRUSTED_PROXY_HINT = "Needs APP_TRUSTED_PROXIES"

export function ExcludeMyIpButton({ exclusion }: { exclusion: MyIpExclusion }) {
  if (exclusion.ip === null) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="Exclude your IP"
      aria-pressed={exclusion.excluded}
      title={`${exclusion.excluded ? "Excluding" : "Exclude"} your IP ${exclusion.ip}`}
      onClick={exclusion.toggle}
      className={cn("relative pointer-coarse:size-11", exclusion.excluded && EXCLUDED_BUTTON)}
    >
      <UserX />
      {exclusion.excluded && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-destructive"
        />
      )}
    </Button>
  )
}

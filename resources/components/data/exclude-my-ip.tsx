/** Controls that exclude the viewer's own IP on the log pages. useMyIpExclusion supplies their state. */
import { Check, UserX } from "lucide-react"
import { FilterField } from "@/components/data/filter-rail"
import { Button } from "@/components/ui/button"
import type { MyIpExclusion } from "@/lib/my-ip-exclusion"
import { cn } from "@/lib/utils"

const EXCLUDED_BUTTON = "border-destructive/50 text-destructive hover:text-destructive dark:border-destructive/50"

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
        <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-destructive" />
      )}
    </Button>
  )
}

export function ExcludeMyIpField({ exclusion }: { exclusion: MyIpExclusion }) {
  if (exclusion.behindUntrustedProxy) {
    return (
      <FilterField label="Exclude your IP" group>
        <span className="flex h-8 items-center text-xs text-muted-foreground">{UNTRUSTED_PROXY_HINT}</span>
      </FilterField>
    )
  }
  if (exclusion.ip === null) return null
  return (
    <FilterField label="Exclude your IP" group>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Exclude your IP, ${exclusion.ip}`}
        aria-pressed={exclusion.excluded}
        onClick={exclusion.toggle}
        className={cn("h-8 font-mono text-xs", exclusion.excluded && EXCLUDED_BUTTON)}
      >
        {exclusion.excluded ? <Check className="size-3.5" /> : <UserX className="size-3.5" />}
        {exclusion.ip}
      </Button>
    </FilterField>
  )
}

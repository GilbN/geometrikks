import { countryDisplayName, flagUrl } from "@/lib/country-flags"
import { cn } from "@/lib/utils"

/**
 * 4x3 flag for an ISO alpha-2 code; renders nothing for anything else.
 * Hidden from assistive tech unless `standalone`: Chromium names an empty-alt
 * img from its title, so a flag beside its country's name reads it twice.
 */
export function CountryFlag({
  code,
  name,
  standalone = false,
  className,
}: {
  code: string | null | undefined
  name?: string | null
  /** No text beside the flag names the place, so the flag carries it. */
  standalone?: boolean
  className?: string
}) {
  const src = flagUrl(code)
  if (!src) return null
  const label = name ?? countryDisplayName(code)
  return (
    <img
      src={src}
      alt={standalone ? (label ?? "") : ""}
      aria-hidden={standalone ? undefined : true}
      title={label}
      loading="lazy"
      decoding="async"
      className={cn("inline-block h-3 w-4 shrink-0 rounded-[2px] object-cover", className)}
    />
  )
}

/** Flag followed by the label, which defaults to the name, then the code. */
export function CountryLabel({
  code,
  name,
  children,
  className,
}: {
  code: string | null | undefined
  name?: string | null
  children?: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <CountryFlag code={code} name={name} />
      {children ?? name ?? code}
    </span>
  )
}

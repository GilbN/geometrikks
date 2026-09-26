import { countryDisplayName, flagUrl } from "@/lib/country-flags"
import { cn } from "@/lib/utils"

/** 4x3 flag for an ISO alpha-2 code; renders nothing for anything else. */
export function CountryFlag({
  code,
  name,
  className,
}: {
  code: string | null | undefined
  name?: string | null
  className?: string
}) {
  const src = flagUrl(code)
  if (!src) return null
  return (
    <img
      src={src}
      alt=""
      title={name ?? countryDisplayName(code)}
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

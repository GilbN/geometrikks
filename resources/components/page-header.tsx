import { usePublishPageSubtitle } from "@/lib/page-heading"
import { cn } from "@/lib/utils"

/**
 * What a page adds under the top bar, which names the page and shows the
 * subtitle as a hint on the title. On a wide screen that is the actions row,
 * right-aligned. On a phone the subtitle shows here too when
 * `subtitleOnPhone` asks for it, for a page whose subtitle explains what it
 * is for, and `meta` shows only on a phone, where no range button gives the
 * dates. A header with nothing to show takes no space.
 */
export function PageHeader({
  subtitle,
  meta,
  actions,
  subtitleOnPhone = false,
  className,
}: {
  subtitle?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  subtitleOnPhone?: boolean
  className?: string
}) {
  usePublishPageSubtitle(subtitle)
  const phoneSubtitle = subtitleOnPhone && subtitle
  if (!actions && !meta && !phoneSubtitle) return null
  return (
    <header
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-3",
        !actions && "hidden phone:flex",
        phoneSubtitle && "phone:flex-nowrap phone:justify-between",
        meta && "phone:justify-start",
        className,
      )}
    >
      {meta && <div className="hidden min-h-7 min-w-0 items-center phone:flex">{meta}</div>}
      {phoneSubtitle && (
        <p className="mt-1 hidden text-[13px] text-muted-foreground phone:block phone:flex-1">
          {subtitle}
        </p>
      )}
      {actions && (
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-2",
            phoneSubtitle && "phone:shrink-0",
          )}
        >
          {actions}
        </div>
      )}
    </header>
  )
}

import { cn } from "@/lib/utils"

/**
 * Standard page chrome: the route's one <h1> (+ optional meta chip inline)
 * and subtitle on the left, actions on the right, wrapping beneath on
 * narrow screens. Typography per the design spec: page title
 * 20px / weight 650 / -0.01em tracking; subtitle 13px muted.
 *
 * On a phone the top bar already names the page, so the title and subtitle are
 * only there for screen readers, and a header with nothing else in it takes
 * no space. `subtitleOnPhone` keeps the subtitle visible there, beside the
 * actions, for a page whose subtitle explains what it is for.
 */
export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  subtitleOnPhone = false,
  className,
}: {
  title: string
  subtitle?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  subtitleOnPhone?: boolean
  className?: string
}) {
  return (
    <header
      className={cn(
        "flex min-w-0 flex-wrap items-start justify-between gap-3",
        !meta && !actions && !subtitleOnPhone && "phone:sr-only",
        subtitleOnPhone && "phone:flex-nowrap phone:items-center",
        className
      )}
    >
      <div className={cn("min-w-0 space-y-1", subtitleOnPhone && "phone:flex-1")}>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-xl font-[650] tracking-[-0.01em] phone:sr-only">{title}</h1>
          {meta}
        </div>
        {subtitle && (
          <p className={cn("text-[13px] text-muted-foreground", !subtitleOnPhone && "phone:sr-only")}>{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className={cn("flex min-w-0 flex-wrap items-center gap-2", subtitleOnPhone && "phone:shrink-0")}>
          {actions}
        </div>
      )}
    </header>
  )
}

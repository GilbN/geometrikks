import { cn } from "@/lib/utils"

/**
 * Standard page chrome: title (+ optional meta chip inline) and subtitle on
 * the left, actions on the right. Typography per the design spec: page title
 * 20px / weight 650 / -0.01em tracking; subtitle 13px muted.
 */
export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  className,
}: {
  title: string
  subtitle?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-[650] tracking-[-0.01em]">{title}</h1>
          {meta}
        </div>
        {subtitle && <p className="text-[13px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

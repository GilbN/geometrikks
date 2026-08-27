import { cn } from "@/lib/utils"

/** Section divider: uppercase tracked label + hairline rule. */
export function SectionHeader({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {children}
      </h2>
      <div className="h-px flex-1 bg-border/50" />
    </div>
  )
}

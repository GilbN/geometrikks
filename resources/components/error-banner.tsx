import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"

/** The one destructive banner. `detail` renders muted beneath the title. */
export function ErrorBanner({
  title,
  detail,
  className,
}: {
  title: string
  detail?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm",
        className
      )}
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <p>{title}</p>
      </div>
      {detail && <p className="mt-1 pl-6 text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

/** Right-side record viewer: full-screen on phones, a bounded panel from
 * `sm` up. The body scrolls; the header stays. */
export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="full-mobile" className={cn("gap-0", className)}>
        <SheetHeader className="shrink-0 border-b border-border/50 pr-16">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className={cn(!description && "sr-only")}>
            {description ?? "Record details"}
          </SheetDescription>
        </SheetHeader>
        <div data-slot="detail-sheet-content" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Label/value row for a detail sheet. Pass `mono` for IPs, URLs and
 * other machine strings. Missing values render as "Not recorded" so the
 * field list is the same for every record. */
export function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  const empty = value === null || value === undefined || value === ""
  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)] gap-x-3 gap-y-0.5 border-b border-border/40 py-2 text-sm last:border-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-xs", empty && "text-muted-foreground")}>
        {empty ? "Not recorded" : value}
      </dd>
    </div>
  )
}

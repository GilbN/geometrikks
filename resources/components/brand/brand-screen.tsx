import { BrandMark } from "@/components/brand/brand-mark"
import { Wordmark } from "@/components/brand/wordmark"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * Full-screen brand moment for states outside the app chrome: login, the
 * root error boundary and the 404 page. Aurora backdrop, mark and wordmark
 * above a single card holding `children`.
 */
export function BrandScreen({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4 overflow-hidden">
      {/* Aurora backdrop: two soft glows in the brand accent. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(640px 420px at 18% -8%, var(--primary-glow), transparent 70%), radial-gradient(720px 520px at 108% 108%, var(--primary-glow), transparent 70%)",
        }}
      />
      <div className={cn("relative flex w-full max-w-sm flex-col items-center gap-6", className)}>
        <div className="flex flex-col items-center gap-4">
          <BrandMark size={72} className="text-foreground" decorative />
          <Wordmark sub className="items-center text-[26px] text-foreground" />
        </div>
        <Card className="w-full">
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </div>
    </div>
  )
}

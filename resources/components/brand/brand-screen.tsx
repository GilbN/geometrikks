import { BrandMark } from "@/components/brand/brand-mark"
import { Wordmark } from "@/components/brand/wordmark"
import { cn } from "@/lib/utils"

/**
 * Full-screen brand moment for states outside the app chrome: login, the
 * root error boundary and the 404 page. One card on the aurora backdrop;
 * the card's header carries the mark, wordmark, the page's H1 and a line of
 * context, the body carries `children`.
 */
export function BrandScreen({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
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
      <section
        aria-labelledby="brand-screen-title"
        className={cn(
          "relative w-full max-w-sm overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-border shadow-[var(--shadow-card)]",
          className,
        )}
      >
        <header className="border-b border-border/50 bg-muted/30 px-6 pb-5 pt-7 text-center">
          <div className="inline-flex items-center gap-3 animate-in fade-in-0 zoom-in-95 duration-500 motion-reduce:animate-none">
            <BrandMark size={40} className="text-foreground" decorative />
            <Wordmark sub className="items-start text-[22px] text-foreground" />
          </div>
          <h1 id="brand-screen-title" className="mt-5 text-lg font-[650] tracking-[-0.01em]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
          )}
        </header>
        <div className="p-6">{children}</div>
      </section>
    </div>
  )
}

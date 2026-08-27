import { cn } from "@/lib/utils"

export type LedTone = "accent" | "emerald" | "amber" | "red" | "muted"

const toneClasses: Record<LedTone, string> = {
  accent: "bg-primary shadow-[0_0_6px_var(--primary)]",
  emerald: "bg-emerald-500 shadow-[0_0_6px_var(--color-emerald-500)]",
  amber: "bg-amber-500 shadow-[0_0_6px_var(--color-amber-500)]",
  red: "bg-red-500 shadow-[0_0_6px_var(--color-red-500)]",
  muted: "border border-muted-foreground/40 bg-transparent",
}

const pingClasses: Record<LedTone, string> = {
  accent: "bg-primary",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  muted: "bg-muted-foreground",
}

/** Small status dot with the same glow language as the sidebar indicator. */
export function StatusLed({
  tone,
  pulse = false,
  className,
}: {
  tone: LedTone
  pulse?: boolean
  className?: string
}) {
  return (
    <span className={cn("relative inline-flex h-2 w-2 shrink-0", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping motion-reduce:animate-none",
            pingClasses[tone],
          )}
        />
      )}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", toneClasses[tone])} />
    </span>
  )
}

/** Monospace chip for machine values: env vars, triggers, versions, paths. */
export function MonoChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {children}
    </code>
  )
}

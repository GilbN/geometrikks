/** Dashboard section divider: small caps label plus a hairline rule. */
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h2>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  )
}

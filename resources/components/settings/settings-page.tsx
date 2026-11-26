import { PageHeader } from "@/components/page-header"

/** A Settings child page. The top bar names it under Settings and shows the
 * subtitle as a hint on the title. */
export function SettingsPage({
  subtitle,
  actions,
  subtitleOnPhone,
  toolbar,
  children,
}: {
  subtitle: string
  /** Buttons for the page, such as its Create button. */
  actions?: React.ReactNode
  /** Keeps the subtitle visible on a phone, for a page it explains. */
  subtitleOnPhone?: boolean
  /** Page-level controls, on a glass band over the relief. */
  toolbar?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-4">
      <PageHeader subtitle={subtitle} actions={actions} subtitleOnPhone={subtitleOnPhone} />
      {toolbar && (
        <div className="rounded-xl bg-glass-card px-5 py-4 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px]">
          {toolbar}
        </div>
      )}
      {children}
    </div>
  )
}

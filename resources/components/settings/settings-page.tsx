import { PageHeader } from "@/components/page-header"

/** Every Settings child renders its own title, so the H1 names the page
 * being viewed rather than "Settings". */
export function SettingsPage({
  title,
  subtitle,
  toolbar,
  children,
}: {
  title: string
  subtitle: string
  /** Page-level controls that belong with the title, inside the band. */
  toolbar?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-4">
      {/* Glass band: the title and any page toolbar sit on it, over the relief. */}
      <div className="space-y-4 rounded-xl bg-card/55 px-5 py-4 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px]">
        <PageHeader title={title} subtitle={subtitle} />
        {toolbar}
      </div>
      {children}
    </div>
  )
}

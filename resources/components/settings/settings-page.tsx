import { PageHeader } from "@/components/page-header"

/** Every Settings child renders its own title, so the H1 names the page
 * being viewed rather than "Settings". */
export function SettingsPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-4">
      <PageHeader title={title} subtitle={subtitle} />
      {children}
    </div>
  )
}

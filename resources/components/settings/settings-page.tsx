import { PageHeader } from "@/components/page-header"
import { cn } from "@/lib/utils"

/** Every Settings child renders its own title, so the H1 names the page
 * being viewed rather than "Settings". */
export function SettingsPage({
  title,
  subtitle,
  actions,
  subtitleOnPhone,
  toolbar,
  children,
}: {
  title: string
  subtitle: string
  /** Buttons beside the title, such as a page's Create button. */
  actions?: React.ReactNode
  /** Keeps the subtitle visible below md, where the top bar names the page. */
  subtitleOnPhone?: boolean
  /** Page-level controls that belong with the title, inside the band. */
  toolbar?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-4">
      {/* Glass band: the title and any page toolbar sit on it, over the relief.
          Below md the title is for screen readers only, so a band without a
          toolbar drops its box rather than show up empty. */}
      <div
        className={cn(
          "space-y-4 rounded-xl bg-glass-card px-5 py-4 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur-[2px]",
          !toolbar && "max-md:contents"
        )}
      >
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={actions}
          subtitleOnPhone={subtitleOnPhone}
          // The band loses its own margin while it is `display: contents`.
          className={cn(!toolbar && "max-md:mb-4")}
        />
        {toolbar}
      </div>
      {children}
    </div>
  )
}

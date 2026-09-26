/**
 * Links out to CrowdSec CTI, the CrowdSec Hub and bgp.he.net. They open in a
 * new tab with no Referer header, so those sites see the IP being looked up
 * but not this instance's URL.
 */
import { ExternalLink as ExternalLinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-0.5 underline-offset-2 hover:underline", className)}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
    </a>
  )
}

export function ExternalLinkButton({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <Button asChild variant="ghost" size="icon-xs" className={cn("align-middle text-muted-foreground", className)}>
      <a href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
        <ExternalLinkIcon />
      </a>
    </Button>
  )
}

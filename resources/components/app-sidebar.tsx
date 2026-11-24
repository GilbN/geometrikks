import { Link, useRouterState } from "@tanstack/react-router"
import { useEffect } from "react"
import { Fragment, type ReactNode } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AlertCircle } from "lucide-react"
import { NAV_ITEMS, SETTINGS_ITEM, type NavId, type NavItem as NavItemData } from "@/lib/phone-nav"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/api"
import { BrandMark } from "@/components/brand/brand-mark"
import { Wordmark } from "@/components/brand/wordmark"
import { useServiceStatus } from "@/hooks/use-service-status"
import { useCrowdsecStats, useSecurityNavStatus } from "@/lib/queries"
import { formatNavCount, formatRequestRate, ingestionInFooter } from "@/lib/sidebar-status"
import { ReloadNoticeCard, ReloadNoticeCollapsedButton } from "@/components/reload-notice"
import { SidebarUserMenu } from "@/components/sidebar-user-menu"

function GeoLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center py-1 transition-all duration-200",
        collapsed ? "justify-center px-0 gap-0" : "justify-start px-2 gap-3",
      )}
    >
      <BrandMark size={40} className="text-sidebar-foreground" decorative />
      <div
        className={cn(
          "flex flex-col overflow-hidden transition-all duration-200",
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
        )}
      >
        <Wordmark sub className="text-[25px] text-sidebar-foreground" />
      </div>
    </div>
  )
}

function NavItem({
  item,
  isActive,
  warning,
  count,
}: {
  item: NavItemData
  isActive: boolean
  warning?: string
  count?: { value: number; label: string }
}) {
  const Icon = item.icon

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={{
          children: (
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="font-medium">{item.title}</span>
                <span className="text-muted-foreground text-xs">{item.description}</span>
              </span>
              {warning && (
                <span className="text-amber-700 dark:text-amber-400 text-xs">{warning}</span>
              )}
              {count && (
                <span className="text-xs">
                  {formatNumber(count.value)} {count.label}
                </span>
              )}
            </span>
          ),
        }}
        className={cn(
          "relative group/nav-item transition-all duration-200",
          isActive && [
            "data-active:bg-[var(--nav-active-bg)]",
            "before:opacity-[var(--nav-indicator-opacity)]",
            "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2",
            "before:w-[3px] before:h-5 before:rounded-r-full",
            "before:bg-primary before:shadow-[0_0_8px_var(--primary)]",
          ],
        )}
      >
        <Link to={item.url}>
          <div className="relative">
            <Icon
              className={cn(
                "w-4 h-4 transition-colors duration-200",
                isActive
                  ? "text-primary"
                  : "text-[color:var(--nav-inactive-icon)] group-hover/nav-item:text-sidebar-foreground",
              )}
            />
            {isActive && <div className="absolute inset-0 blur-sm bg-primary/30 rounded-full" />}
            {warning && (
              <span
                className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400"
                aria-hidden="true"
              />
            )}
          </div>
          <span
            className={cn(
              "transition-colors duration-200",
              isActive
                ? "text-sidebar-foreground font-medium"
                : "text-[color:var(--nav-inactive-text)] group-hover/nav-item:text-sidebar-foreground",
            )}
          >
            {item.title}
          </span>
          {count && (
            <span className="sr-only">
              , {formatNumber(count.value)} {count.label}
            </span>
          )}
        </Link>
      </SidebarMenuButton>
      {count && (
        <SidebarMenuBadge
          aria-hidden="true"
          className="right-2 rounded-full px-[7px] text-[11px] font-semibold bg-red-500/15 text-red-600 dark:text-red-400"
        >
          {formatNavCount(count.value)}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

function StatusDot({ color, pulse }: { color: string; pulse: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center">
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            color,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  )
}

/** The smoke test finds the status by this link name, so every placement keeps it. */
function StatusLink({ className, children }: { className: string; children: ReactNode }) {
  const { tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  const { tooltip, statusRoute } = useServiceStatus()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={statusRoute}
          aria-label="Service status"
          className={className}
          onPointerLeave={resetTooltipSuppression}
        >
          {children}
        </Link>
      </TooltipTrigger>
      {!tooltipsSuppressed && (
        <TooltipContent side="right">
          <span>{tooltip}</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function CollapsedStatus() {
  const { variant, color } = useServiceStatus()
  return (
    <StatusLink className="mx-2 flex items-center justify-center py-2">
      <StatusDot color={color} pulse={variant === "running"} />
    </StatusLink>
  )
}

function StatusProblem() {
  const { variant, color, label } = useServiceStatus()
  const offline = variant === "offline"

  return (
    <StatusLink
      className={cn(
        "mx-2 flex items-center gap-2 rounded-md border px-3 py-2 transition-colors",
        offline
          ? "border-sidebar-border bg-sidebar-accent/50 hover:bg-sidebar-accent"
          : "border-amber-400/40 bg-amber-400/10 hover:bg-amber-400/15",
      )}
    >
      <StatusDot color={color} pulse={false} />
      <span
        className={cn(
          "text-xs font-medium",
          offline ? "text-sidebar-foreground/70" : "text-amber-700 dark:text-amber-300",
        )}
      >
        {label}
      </span>
      <AlertCircle className={cn("ml-auto size-3", offline ? "text-gray-400" : "text-amber-500")} />
    </StatusLink>
  )
}

function StatusFooterRow() {
  const { variant, color, label, requestsPerMinute } = useServiceStatus()
  const running = variant === "running"

  return (
    <StatusLink className="flex h-[30px] items-center gap-2 rounded-md px-2.5 text-xs text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50">
      <StatusDot color={color} pulse={running} />
      <span className="font-medium text-sidebar-foreground">{label}</span>
      {running && requestsPerMinute !== null && (
        <span className="ml-auto tabular-nums">{formatRequestRate(requestsPerMinute)}</span>
      )}
    </StatusLink>
  )
}

const GROUP_STARTS: ReadonlySet<NavId> = new Set(["access-logs", "security"])

function groupNavItems(items: NavItemData[]): NavItemData[][] {
  const groups: NavItemData[][] = []
  for (const item of items) {
    if (groups.length === 0 || GROUP_STARTS.has(item.id)) groups.push([])
    groups[groups.length - 1].push(item)
  }
  return groups
}

export function AppSidebar() {
  const { state, isMobile, setOpenMobile } = useSidebar()
  // On mobile, always show expanded content regardless of desktop collapsed state
  const collapsed = isMobile ? false : state === "collapsed"
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { status: securityStatus } = useSecurityNavStatus()
  const visibleNavigationItems = NAV_ITEMS.filter(
    (item) => !item.requiresSecurityFeature || securityStatus?.enabled === true,
  )

  const { variant, crowdsecDown } = useServiceStatus()
  const statusInFooter = ingestionInFooter(variant)
  const { data: crowdsecStats } = useCrowdsecStats()
  const activeDecisions =
    !crowdsecDown && crowdsecStats && crowdsecStats.total > 0
      ? { value: crowdsecStats.total, label: "active decisions" }
      : undefined

  // The mobile sidebar is a full-height sheet; leaving it open after a nav
  // tap would cover the page the user just navigated to.
  useEffect(() => {
    setOpenMobile(false)
  }, [currentPath, setOpenMobile])

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader>
        <GeoLogo collapsed={collapsed} />
      </SidebarHeader>

      <SidebarSeparator className="opacity-50" />

      <SidebarContent>
        {(collapsed || !statusInFooter) && (
          <div className="mt-2">{collapsed ? <CollapsedStatus /> : <StatusProblem />}</div>
        )}

        <SidebarGroup className="mt-0.5">
          <SidebarGroupContent>
            {groupNavItems(visibleNavigationItems).map((group, index) => (
              <Fragment key={group[0].id}>
                {index > 0 && <SidebarSeparator className="my-2.5" />}
                <SidebarMenu>
                  {group.map((item) => (
                    <NavItem
                      key={item.id}
                      item={item}
                      isActive={
                        item.url === "/" ? currentPath === "/" : currentPath.startsWith(item.url)
                      }
                      warning={
                        item.id === "security" && crowdsecDown
                          ? "CrowdSec LAPI unreachable"
                          : undefined
                      }
                      count={item.id === "security" ? activeDecisions : undefined}
                    />
                  ))}
                </SidebarMenu>
              </Fragment>
            ))}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem item={SETTINGS_ITEM} isActive={currentPath.startsWith(SETTINGS_ITEM.url)} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1.5">
        {collapsed ? <ReloadNoticeCollapsedButton /> : <ReloadNoticeCard />}
        {!collapsed && statusInFooter && <StatusFooterRow />}
        <SidebarUserMenu />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

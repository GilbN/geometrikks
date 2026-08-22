import { Link, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useState, useEffect } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  LayoutDashboard,
  Map,
  MapPinned,
  FileText,
  BarChart3,
  Settings,
  ChevronLeft,
  Activity,
  Globe2,
  AlertCircle,
  Bug,
  LogOut,
  PowerOff,
  ShieldBan,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { fetchHealth, logout } from "@/lib/api"
import { BrandMark } from "@/components/brand/brand-mark"
import { Wordmark } from "@/components/brand/wordmark"
import {
  sidebarIngestionVariant,
  type SidebarIngestionVariant,
} from "@/components/settings/status-logic"
import { useLiveFeedStatus } from "@/lib/live-feed-context"
import { useCrowdsecStatus, useMe, useRuntimeSettings } from "@/lib/queries"
import { SiDocker } from "react-icons/si"

const navigationItems = [
  {
    title: "Overview",
    url: "/",
    icon: LayoutDashboard,
    description: "Dashboard home",
  },
  {
    title: "Map",
    url: "/map",
    icon: Map,
    description: "Geographic view",
  },
  {
    title: "Access Logs",
    url: "/access-logs",
    icon: FileText,
    description: "Request logs",
  },
  {
    title: "Geo Logs",
    url: "/geo-logs",
    icon: MapPinned,
    description: "Geolocation logs",
  },
  {
    title: "Debug Logs",
    url: "/debug-logs",
    icon: Bug,
    description: "Raw & malformed lines",
  },
  {
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
    description: "Statistics & trends",
  },
  {
    title: "Security",
    url: "/security",
    icon: ShieldBan,
    description: "CrowdSec bans & alerts",
    // Hidden until the CrowdSec integration is configured
    requiresCrowdsec: true,
  },
]

const secondaryItems = [
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
    description: "Configuration",
  },
]

function GeoLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center py-1 transition-all duration-200",
        collapsed ? "justify-center px-0 gap-0" : "justify-start px-2 gap-3"
      )}
    >
      <BrandMark
        size={30}
        className="text-sidebar-foreground"
        decorative
      />
      <div
        className={cn(
          "flex flex-col overflow-hidden transition-all duration-200",
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
        )}
      >
        <Wordmark sub className="text-[21px] text-sidebar-foreground" />
      </div>
    </div>
  )
}

function NavItem({
  item,
  isActive,
  warning,
}: {
  item: (typeof navigationItems)[0]
  isActive: boolean
  warning?: string
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
                <span>{item.title}</span>
                <span className="text-muted-foreground text-xs">{item.description}</span>
              </span>
              {warning && <span className="text-amber-500 text-xs">{warning}</span>}
            </span>
          ),
        }}
        className={cn(
          "relative group/nav-item transition-all duration-200",
          isActive && [
            "bg-sidebar-accent/80",
            "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2",
            "before:w-[3px] before:h-5 before:rounded-r-full",
            "before:bg-primary before:shadow-[0_0_8px_var(--primary)]",
          ]
        )}
      >
        <Link to={item.url}>
          <div className="relative">
            <Icon
              className={cn(
                "w-4 h-4 transition-colors duration-200",
                isActive
                  ? "text-primary"
                  : "text-sidebar-foreground/60 group-hover/nav-item:text-sidebar-foreground"
              )}
            />
            {isActive && (
              <div className="absolute inset-0 blur-sm bg-primary/30 rounded-full" />
            )}
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
                : "text-sidebar-foreground/70 group-hover/nav-item:text-sidebar-foreground"
            )}
          >
            {item.title}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function LiveIndicator({ collapsed }: { collapsed: boolean }) {
  const { tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  const { data: health, isError } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10000, // Poll every 10 seconds
    retry: 1,
  })

  const variant = sidebarIngestionVariant(health, isError)
  const isRunning = variant === "running"

  const INDICATOR_STYLES: Record<SidebarIngestionVariant, { color: string; label: string; tooltip: string }> = {
    offline: { color: "bg-gray-400", label: "Offline", tooltip: "Cannot connect to backend" },
    degraded: { color: "bg-amber-400", label: "Degraded", tooltip: "Service degraded - see Settings > Status" },
    // Neutral, not amber: LOGPARSER_ENABLED=false is a deliberate setting
    // (UI-head deployments); other instances or agents write the data.
    disabled: { color: "bg-sidebar-foreground/30", label: "Ingestion off", tooltip: "Log tailing is turned off (LOGPARSER_ENABLED=false)" },
    running: { color: "bg-emerald-400", label: "Live ingestion", tooltip: "Live ingestion active" },
    inactive: { color: "bg-gray-400", label: "Inactive", tooltip: "Service status unknown" },
  }

  const { color, label, tooltip } = INDICATOR_STYLES[variant]

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/settings/status"
            aria-label="Service status"
            className="flex items-center justify-center py-2 mx-2"
            onPointerLeave={resetTooltipSuppression}
          >
            <div className="relative flex items-center justify-center w-3 h-3">
              {isRunning && (
                <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", color)} />
              )}
              <span className={cn("relative inline-flex w-2 h-2 rounded-full", color)} />
            </div>
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/settings/status"
          aria-label="Service status"
          className="flex items-center gap-2 px-3 py-2 mx-2 rounded-md bg-sidebar-accent/50 border border-sidebar-border transition-colors hover:bg-sidebar-accent"
          onPointerLeave={resetTooltipSuppression}
        >
          <div className="relative flex items-center justify-center w-2 h-2">
            {isRunning && (
              <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", color)} />
            )}
            <span className={cn("relative inline-flex w-2 h-2 rounded-full", color)} />
          </div>
          <span className="text-xs font-medium text-sidebar-foreground/70">
            {label}
          </span>
          {variant === "running" ? (
            <Activity className="w-3 h-3 text-emerald-400 ml-auto" />
          ) : variant === "disabled" ? (
            // Deliberate setting, not a fault: no warning glyph.
            <PowerOff className="w-3 h-3 text-sidebar-foreground/40 ml-auto" />
          ) : variant === "offline" ? (
            <AlertCircle className="w-3 h-3 text-gray-400 ml-auto" />
          ) : (
            <AlertCircle className="w-3 h-3 text-amber-400 ml-auto" />
          )}
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

function LiveFeedIndicator({ collapsed }: { collapsed: boolean }) {
  const { tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  // WebSocket live-feed status, distinct from the ingestion-health dot above.
  // Lazy-connect: reads "Live feed off" until a consumer (map pulses or the
  // access-logs live tail) subscribes to the shared connection.
  const status = useLiveFeedStatus()
  const color =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-sidebar-foreground/30"
  const label =
    status === "connected" ? "Live feed" : status === "connecting" ? "Connecting" : "Live feed off"
  const tooltip =
    status === "connected"
      ? "Live event feed connected"
      : status === "connecting"
        ? "Connecting to live event feed"
        : "Live feed idle (no active subscribers)"

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex items-center justify-center py-1 mx-2"
            onPointerLeave={resetTooltipSuppression}
          >
            <span className={cn("inline-flex w-2 h-2 rounded-full", color)} />
          </div>
        </TooltipTrigger>
        {!tooltipsSuppressed && (
          <TooltipContent side="right">
            <span>{tooltip}</span>
          </TooltipContent>
        )}
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1 mx-2 text-xs text-sidebar-foreground/60">
      <span className={cn("inline-flex w-2 h-2 rounded-full", color)} />
      <span className="font-medium">{label}</span>
    </div>
  )
}

function LogoutButton() {
  const { state, isMobile, tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  const collapsed = isMobile ? false : state === "collapsed"

  // Only render when there is a session to end. /auth/me reports
  // mode: "disabled" when APP_AUTH_DISABLED=true, and a 401 already
  // redirects to /login via the api interceptor.
  const { data: me } = useMe()

  if (me?.mode !== "session") return null

  async function onLogout() {
    try {
      await logout()
    } finally {
      // Hard navigation is deliberate, not a leftover: it discards the
      // TanStack Query cache holding the previous session's data, which a
      // client-side redirect would not. The /logout route does the same.
      window.location.href = "/login"
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onLogout}
          onPointerLeave={resetTooltipSuppression}
          className={cn(
            "flex items-center justify-center w-full py-2",
            collapsed ? "px-0" : "px-3",
            "text-sidebar-foreground/50 hover:text-sidebar-foreground",
            "hover:bg-sidebar-accent/50 rounded-md transition-all duration-200"
          )}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          <span
            className={cn(
              "text-xs font-medium overflow-hidden transition-all duration-200",
              collapsed ? "ml-0 w-0 opacity-0" : "ml-2 w-auto opacity-100"
            )}
          >
            Log out
          </span>
        </button>
      </TooltipTrigger>
      {collapsed && !tooltipsSuppressed && (
        <TooltipContent side="right">
          <span>Log out {me.username}</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function CollapseToggle() {
  const { toggleSidebar, state, isMobile, resetTooltipSuppression } = useSidebar()
  const collapsed = state === "collapsed"
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [suppressTooltip, setSuppressTooltip] = useState(false)

  // Don't show collapse toggle on mobile - sidebar is always expanded when open
  if (isMobile) return null

  function onToggle(event: React.MouseEvent<HTMLButtonElement>) {
    // The trigger stays focused and hovered after its click. Suppress that
    // state so collapsing cannot open its new "Expand sidebar" tooltip.
    setSuppressTooltip(true)
    setTooltipOpen(false)
    event.currentTarget.blur()
    toggleSidebar()
  }

  function onTooltipOpenChange(open: boolean) {
    if (!suppressTooltip) setTooltipOpen(open)
  }

  return (
    <Tooltip open={tooltipOpen} onOpenChange={onTooltipOpenChange}>
      <TooltipTrigger asChild>
        <button
          onClick={onToggle}
          onPointerLeave={() => {
            setSuppressTooltip(false)
            setTooltipOpen(false)
            resetTooltipSuppression()
          }}
          className={cn(
            "flex items-center justify-center w-full py-2",
            collapsed ? "px-0" : "px-3",
            "text-sidebar-foreground/50 hover:text-sidebar-foreground",
            "hover:bg-sidebar-accent/50 rounded-md transition-all duration-200",
            "group/collapse"
          )}
        >
          <ChevronLeft
            className={cn(
              "w-4 h-4 shrink-0 transition-transform duration-300",
              collapsed && "rotate-180"
            )}
          />
          <span
            className={cn(
              "text-xs font-medium overflow-hidden transition-all duration-200",
              collapsed ? "ml-0 w-0 opacity-0" : "ml-2 w-auto opacity-100"
            )}
          >
            Collapse
          </span>
        </button>
      </TooltipTrigger>
      {collapsed && !suppressTooltip && (
        <TooltipContent side="right">
          <span>Expand sidebar</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function RuntimeMetadata({ collapsed }: { collapsed: boolean }) {
  const { data: settings } = useRuntimeSettings()

  if (collapsed || !settings) return null

  const imageTag = settings.runtime.imageTag
  const runtimeLabel = imageTag
    ? `Container image ${imageTag}`
    : "Running in a container"

  return (
    <div className="flex items-center justify-center gap-1.5 px-3 py-2 text-sidebar-foreground/30">
      <span className="text-[10px] font-mono">v{settings.version}</span>
      {settings.runtime.container && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default" aria-label={runtimeLabel}>
              <SiDocker aria-hidden="true" className="h-4 w-4 text-[#2496ED]" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span>{runtimeLabel}</span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

export function AppSidebar() {
  const { state, isMobile, setOpenMobile } = useSidebar()
  // On mobile, always show expanded content regardless of desktop collapsed state
  const collapsed = isMobile ? false : state === "collapsed"
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { data: crowdsecStatus } = useCrowdsecStatus()
  const visibleNavigationItems = navigationItems.filter(
    (item) => !("requiresCrowdsec" in item) || crowdsecStatus?.enabled === true,
  )

  // Shares the ["health"] cache with LiveIndicator's 10s poll.
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 30000,
    retry: 1,
  })
  const crowdsecDown =
    health?.crowdsec?.enabled === true && health.crowdsec.lapiReachable === false

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
        {/* Live status indicators: ingestion health + websocket live feed */}
        <LiveIndicator collapsed={collapsed} />
        <LiveFeedIndicator collapsed={collapsed} />

        <SidebarGroup className="mt-2">
          <SidebarGroupLabel
            className={cn(
              "text-[10px] font-semibold tracking-widest uppercase text-sidebar-foreground/40",
              "flex items-center gap-2"
            )}
          >
            <Globe2 className="w-3 h-3" />
            {!collapsed && "Navigation"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleNavigationItems.map((item) => (
                <NavItem
                  key={item.title}
                  item={item}
                  isActive={
                    item.url === "/"
                      ? currentPath === "/"
                      : currentPath.startsWith(item.url)
                  }
                  warning={
                    item.url === "/security" && crowdsecDown
                      ? "CrowdSec LAPI unreachable"
                      : undefined
                  }
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel
            className={cn(
              "text-[10px] font-semibold tracking-widest uppercase text-sidebar-foreground/40"
            )}
          >
            {!collapsed && "System"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {secondaryItems.map((item) => (
                <NavItem
                  key={item.title}
                  item={item}
                  isActive={currentPath.startsWith(item.url)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator className="opacity-50" />
        <LogoutButton />
        <CollapseToggle />
        <RuntimeMetadata collapsed={collapsed} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

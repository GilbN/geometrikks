"use client"

import { Link, useRouterState } from "@tanstack/react-router"
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
  FileText,
  BarChart3,
  Settings,
  ChevronLeft,
  Activity,
  Globe2,
} from "lucide-react"
import { cn } from "@/lib/utils"

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
    url: "/logs",
    icon: FileText,
    description: "Request logs",
  },
  {
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
    description: "Statistics & trends",
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
      {/* Geometric marker icon */}
      <div className="relative flex-shrink-0">
        <div className="relative w-8 h-8 flex items-center justify-center">
          {/* Outer glow */}
          <div className="absolute inset-0 rounded-lg bg-geo-cyan/20 blur-sm" />
          {/* Main shape */}
          <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-geo-cyan to-geo-cyan-dim flex items-center justify-center shadow-lg shadow-geo-glow">
            {/* Inner geometric pattern */}
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 text-sidebar-primary-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* Hexagonal grid / geo marker hybrid */}
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
        </div>
      </div>
      {/* Brand text */}
      <div
        className={cn(
          "flex flex-col overflow-hidden transition-all duration-200",
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
        )}
      >
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground whitespace-nowrap">
          Geo<span className="text-geo-cyan">Metrikks</span>
        </span>
        <span className="text-[10px] font-medium text-sidebar-foreground/50 tracking-widest uppercase whitespace-nowrap">
          Analytics
        </span>
      </div>
    </div>
  )
}

function NavItem({
  item,
  isActive,
  collapsed,
}: {
  item: (typeof navigationItems)[0]
  isActive: boolean
  collapsed: boolean
}) {
  const Icon = item.icon

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            asChild
            isActive={isActive}
            tooltip={item.title}
            className={cn(
              "relative group/nav-item transition-all duration-200",
              isActive && [
                "bg-sidebar-accent/80",
                "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2",
                "before:w-[3px] before:h-5 before:rounded-r-full",
                "before:bg-geo-cyan before:shadow-[0_0_8px_var(--geo-cyan)]",
              ]
            )}
          >
            <Link to={item.url}>
              <div className="relative">
                <Icon
                  className={cn(
                    "w-4 h-4 transition-colors duration-200",
                    isActive
                      ? "text-geo-cyan"
                      : "text-sidebar-foreground/60 group-hover/nav-item:text-sidebar-foreground"
                  )}
                />
                {isActive && (
                  <div className="absolute inset-0 blur-sm bg-geo-cyan/30 rounded-full" />
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
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right" className="flex items-center gap-2">
            <span>{item.title}</span>
            <span className="text-muted-foreground text-xs">
              {item.description}
            </span>
          </TooltipContent>
        )}
      </Tooltip>
    </SidebarMenuItem>
  )
}

function LiveIndicator({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-center py-2 mx-2">
            <div className="relative flex items-center justify-center w-3 h-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-400" />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span>Live ingestion active</span>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 mx-2 rounded-md bg-sidebar-accent/50 border border-sidebar-border">
      <div className="relative flex items-center justify-center w-2 h-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-400" />
      </div>
      <span className="text-xs font-medium text-sidebar-foreground/70">
        Live ingestion
      </span>
      <Activity className="w-3 h-3 text-emerald-400 ml-auto" />
    </div>
  )
}

function CollapseToggle() {
  const { toggleSidebar, state } = useSidebar()
  const collapsed = state === "collapsed"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={toggleSidebar}
          className={cn(
            "flex items-center justify-center w-full py-2 px-3",
            "text-sidebar-foreground/50 hover:text-sidebar-foreground",
            "hover:bg-sidebar-accent/50 rounded-md transition-all duration-200",
            "group/collapse"
          )}
        >
          <ChevronLeft
            className={cn(
              "w-4 h-4 transition-transform duration-300",
              collapsed && "rotate-180"
            )}
          />
          <span
            className={cn(
              "ml-2 text-xs font-medium overflow-hidden transition-all duration-200",
              collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
            )}
          >
            Collapse
          </span>
        </button>
      </TooltipTrigger>
      {collapsed && (
        <TooltipContent side="right">
          <span>Expand sidebar</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export function AppSidebar() {
  const { state } = useSidebar()
  const collapsed = state === "collapsed"
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      {/* Subtle background pattern */}
      <div className="absolute inset-0 bg-contour-pattern opacity-50 pointer-events-none" />

      <SidebarHeader className="relative z-10">
        <GeoLogo collapsed={collapsed} />
      </SidebarHeader>

      <SidebarSeparator className="opacity-50" />

      <SidebarContent className="relative z-10">
        {/* Live status indicator */}
        <LiveIndicator collapsed={collapsed} />

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
              {navigationItems.map((item) => (
                <NavItem
                  key={item.title}
                  item={item}
                  isActive={
                    item.url === "/"
                      ? currentPath === "/"
                      : currentPath.startsWith(item.url)
                  }
                  collapsed={collapsed}
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
                  collapsed={collapsed}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="relative z-10">
        <SidebarSeparator className="opacity-50" />
        <CollapseToggle />
        {/* Version tag */}
        {!collapsed && (
          <div className="px-3 py-2 text-center">
            <span className="text-[10px] font-mono text-sidebar-foreground/30">
              v0.1.0-alpha
            </span>
          </div>
        )}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

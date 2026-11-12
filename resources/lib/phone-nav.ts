import {
  BarChart3,
  Bug,
  FileText,
  LayoutDashboard,
  Map,
  MapPinned,
  Settings,
  ShieldBan,
  type LucideIcon,
} from "lucide-react"
import type { SidebarIngestionVariant } from "@/components/settings/status-logic"

export type NavId =
  | "overview"
  | "map"
  | "access-logs"
  | "geo-logs"
  | "debug-logs"
  | "analytics"
  | "security"
  | "settings"

export type NavItem = {
  id: NavId
  title: string
  url: string
  icon: LucideIcon
  description: string
  /** A shorter label for the phone tab bar, where a cell is about 69px wide. */
  barTitle?: string
  requiresSecurityFeature?: true
}

export type SlotFour = "security" | "analytics" | null

export const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    title: "Overview",
    url: "/",
    icon: LayoutDashboard,
    description: "Dashboard home",
  },
  {
    id: "map",
    title: "Map",
    url: "/map",
    icon: Map,
    description: "Geographic view",
  },
  {
    id: "access-logs",
    title: "Access Logs",
    barTitle: "Logs",
    url: "/access-logs",
    icon: FileText,
    description: "Request logs",
  },
  {
    id: "geo-logs",
    title: "Geo Logs",
    url: "/geo-logs",
    icon: MapPinned,
    description: "Geolocation logs",
  },
  {
    id: "debug-logs",
    title: "Debug Logs",
    url: "/debug-logs",
    icon: Bug,
    description: "Raw & malformed lines",
  },
  {
    id: "analytics",
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
    description: "Statistics & trends",
  },
  {
    id: "security",
    title: "Security",
    url: "/security",
    icon: ShieldBan,
    description: "Bans, alerts & AbuseIPDB reports",
    // Hidden until CrowdSec or AbuseIPDB reporting is configured
    requiresSecurityFeature: true,
  },
]

export const SETTINGS_ITEM: NavItem = {
  id: "settings",
  title: "Settings",
  url: "/settings",
  icon: Settings,
  description: "Configuration",
}

function itemById(id: NavId): NavItem {
  const found = [...NAV_ITEMS, SETTINGS_ITEM].find((item) => item.id === id)
  if (!found) throw new Error(`Unknown nav item ${id}`)
  return found
}

export function slotFour(
  status: { enabled?: boolean } | undefined,
  isError: boolean,
): SlotFour {
  if (status === undefined) return isError ? "analytics" : null
  return status.enabled === true ? "security" : "analytics"
}

export function barItems(slot: SlotFour): NavItem[] {
  const ids: NavId[] = ["overview", "map", "access-logs"]
  if (slot) ids.push(slot)
  return ids.map(itemById)
}

export function moreItems(slot: SlotFour): NavItem[] {
  const ids: NavId[] = []
  if (slot !== "analytics") ids.push("analytics")
  ids.push("geo-logs", "debug-logs", "settings")
  return ids.map(itemById)
}

function matchesUrl(pathname: string, url: string): boolean {
  return pathname === url || pathname.startsWith(`${url}/`)
}

export function activeTab(pathname: string, slot: SlotFour): NavId | "more" {
  if (pathname === "/") return "overview"
  const tabs = barItems(slot).filter((item) => item.id !== "overview")
  const match = tabs.find((item) => matchesUrl(pathname, item.url))
  return match ? match.id : "more"
}

export function moreBadge(state: {
  variant: SidebarIngestionVariant
  changelogUnseen: boolean
  releaseUnseen: boolean
  reloadPending: boolean
}): "amber" | "accent" | null {
  if (
    state.variant === "degraded" ||
    state.variant === "offline" ||
    state.variant === "attention"
  ) {
    return "amber"
  }
  if (state.changelogUnseen || state.releaseUnseen || state.reloadPending) {
    return "accent"
  }
  return null
}
